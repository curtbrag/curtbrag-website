"""Approved main-PC relay: mailbox connection checks and fixed tests to self only."""
import base64
import concurrent.futures
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import ssl
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
API = 'https://curtbrag.com/.netlify/functions/fleet-email'
SSH_KEY = Path.home() / '.ssh/id_ed25519'
UNITS = {'phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig','s26ultra'}


class Blob(ctypes.Structure):
    _fields_ = [('size', ctypes.c_ulong), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def decrypt(value):
    raw = bytes.fromhex(value)
    buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source, target = Blob(len(raw), buffer), Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)):
        raise OSError('Credential unavailable')
    try:
        return ctypes.string_at(target.data, target.size).decode('utf-16-le')
    finally:
        ctypes.memset(target.data, 0, target.size)
        ctypes.windll.kernel32.LocalFree(target.data)


def api(action, body=None):
    cfg = json.loads((Path(os.environ['LOCALAPPDATA']) / 'CurtCluster/bridge-config.json').read_text(encoding='utf-8-sig'))
    token = decrypt(cfg['password_cipher'])
    request = urllib.request.Request(API + '?action=' + action,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    token = None
    with urllib.request.urlopen(request, timeout=20, context=ssl.create_default_context()) as response:
        return json.load(response)


def ssh_args(unit):
    return ['ssh', '-T', '-p', str(unit['port']), '-i', str(SSH_KEY),
        '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ConnectTimeout=4', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1',
        unit['user'] + '@' + unit['host']]


def execute(unit, spec):
    if not unit or not unit.get('installed'):
        return {'ok': False, 'error': 'Device email setup pending'}
    if not isinstance(spec, dict) or spec.get('unit') not in UNITS or spec.get('action') not in ('check', 'test') or not re.fullmatch(r'[A-Za-z0-9-]{8,80}', spec.get('id', '')):
        return {'ok': False, 'error': 'Invalid email request'}
    # Rebuild only the permitted fields, so neither remote code nor recipients come from the site.
    request = {'action': spec['action'], 'id': spec['id']}
    if unit.get('local'):
        module_spec = importlib.util.spec_from_file_location('fleet_mail', ROOT / 'cluster-mail.py')
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        config = json.loads((ROOT / 'renderrig.dpapi.json').read_text(encoding='utf-8-sig'))
        config = {key: decrypt(value) if key.endswith('_password') else value for key, value in config.items()}
        try:
            return {'ok': True, **module.run(config, request)}
        except Exception as error:
            return {'ok': False, 'error': type(error).__name__}
    payload = base64.b64encode(json.dumps(request).encode()).decode()
    remote = shlex.quote(unit['python']) + ' "$HOME/cluster/email/cluster-mail.py" ' + shlex.quote(payload)
    try:
        result = subprocess.run(ssh_args(unit) + [remote], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=90)
        return json.loads(result.stdout) if result.stdout.strip() else {'ok': False, 'error': 'Device connection unavailable'}
    except Exception as error:
        return {'ok': False, 'error': type(error).__name__}


def inspect(item):
    name, unit = item
    value = {'installed': unit.get('installed', False), 'connected': False}
    if not value['installed']:
        return name, value
    if unit.get('local'):
        value['connected'] = (ROOT / 'renderrig.dpapi.json').is_file()
    else:
        try:
            result = subprocess.run(ssh_args(unit) + ['test -r "$HOME/cluster/email/mailbox.json" -a -r "$HOME/cluster/email/cluster-mail.py"'],
                stdin=subprocess.DEVNULL, capture_output=True, timeout=8)
            value['connected'] = result.returncode == 0
        except Exception:
            pass
    return name, value


def cycle(inventory, devices):
    api('heartbeat', {'devices': devices})
    pending = ROOT / 'pending-result.json'
    if pending.exists():
        api('complete', json.loads(pending.read_text()))
        pending.unlink()
        return True
    job = api('poll', {})['job']
    if not job:
        return False
    result = execute(inventory.get(job['unit']), job)
    # Persist the result before uploading; uncertain uploads never repeat a send.
    temporary = pending.with_suffix('.tmp')
    temporary.write_text(json.dumps({'id': job['id'], 'result': result}))
    temporary.replace(pending)
    api('complete', {'id': job['id'], 'result': result})
    pending.unlink()
    if result.get('error') in ('Device connection unavailable', 'TimeoutExpired'):
        devices[job['unit']]['connected'] = False
    return True


def main():
    import msvcrt
    lock = (ROOT / 'bridge.lock').open('a+b')
    lock.seek(0)
    lock.write(b'0')
    lock.flush()
    lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        return
    devices, inspected = {}, 0
    while True:
        worked = False
        try:
            inventory = json.loads((ROOT / 'devices.json').read_text(encoding='utf-8'))
            if time.time() - inspected > 90:
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                    devices = dict(pool.map(inspect, inventory.items()))
                inspected = time.time()
            worked = cycle(inventory, devices)
            (ROOT / 'bridge-health.json').write_text(json.dumps({'at': time.time(), 'ok': True}))
        except Exception as error:
            (ROOT / 'bridge-health.json').write_text(json.dumps({'at': time.time(), 'ok': False, 'error': type(error).__name__}))
        if '--once' in sys.argv:
            return
        time.sleep(1 if worked else 10)


if __name__ == '__main__':
    main()
