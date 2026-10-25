"""Approved main-PC relay: mailbox connection checks and fixed tests to self only."""
import base64
import concurrent.futures
import ctypes
import importlib.util
import http.cookiejar
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
import urllib.parse
import urllib.error

ROOT = Path(__file__).resolve().parent
API = 'https://curtbrag.com/.netlify/functions/fleet-email'
SSH_KEY = Path.home() / '.ssh/id_ed25519'
UNITS = {'phone173','phone174','phone176','phone177','phone191','phone195','phone253','phone254','Alina','Nexus','SteamDeck','viki','RenderRig','s26ultra'}
SESSION = None
SESSION_AT = 0
DELIVERY_CHECKS = {}
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


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
    global SESSION, SESSION_AT
    cfg = json.loads((Path(os.environ['LOCALAPPDATA']) / 'CurtCluster/bridge-config.json').read_text(encoding='utf-8-sig'))
    token = decrypt(cfg['password_cipher'])
    if SESSION is None or time.time() - SESSION_AT > 23 * 3600:
        jar = http.cookiejar.CookieJar()
        candidate = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        login = urllib.request.Request('https://curtbrag.com/_site/login',
            data=urllib.parse.urlencode({'password': token, 'return': '/'}).encode(),
            headers={'Origin':'https://curtbrag.com', 'Accept':'application/json',
                'Content-Type':'application/x-www-form-urlencoded'})
        with candidate.open(login, timeout=20) as response:
            reply = json.load(response)
        if reply.get('ok') is not True or not any(cookie.name == '__Host-curtbrag_access' for cookie in jar):
            raise OSError('Normal site sign-in failed')
        SESSION, SESSION_AT = candidate, time.time()
    request = urllib.request.Request(API + '?action=' + action,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    token = None
    try:
        with SESSION.open(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 401:
            SESSION = None
        raise


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
    if spec['action'] == 'check' and spec.get('verify_test') is True:
        request['verify_test'] = True
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
        result = subprocess.run(ssh_args(unit) + [remote], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=90, creationflags=NO_WINDOW)
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
                stdin=subprocess.DEVNULL, capture_output=True, timeout=8, creationflags=NO_WINDOW)
            value['connected'] = result.returncode == 0
        except Exception:
            pass
    return name, value


def save_record(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def finish_pending(pending, inflight):
    value = json.loads(pending.read_text(encoding='utf-8'))
    api('complete', value)
    # Keep the completed result until its matching intent is removed. A crash
    # anywhere here can only upload the same receipt again, never send again.
    if inflight.exists():
        intent = json.loads(inflight.read_text(encoding='utf-8'))
        if intent.get('id') == value.get('id'):
            inflight.unlink()
    pending.unlink()


def cycle(inventory, devices):
    api('heartbeat', {'devices': devices})
    pending = ROOT / 'pending-result.json'
    inflight = ROOT / 'inflight-request.json'
    if pending.exists():
        finish_pending(pending, inflight)
        return True
    if inflight.exists():
        intent = json.loads(inflight.read_text(encoding='utf-8'))
        message = ('Previous request interrupted; sending outcome is unconfirmed. It was not replayed.'
            if intent.get('action') == 'test' else 'Previous connection check interrupted. It was not replayed.')
        save_record(pending, {'id': intent['id'], 'result': {
            'ok': False, 'interrupted': True,
            'delivery_unconfirmed': intent.get('action') == 'test',
            'error': message}})
        finish_pending(pending, inflight)
        return True
    job = api('poll', {})['job']
    if not job:
        # SMTP acceptance precedes arrival. Confirm only our exact prior test,
        # without sending again or fetching any inbox message contents.
        status = api('status')
        for previous in status.get('jobs', []):
            ident = previous['id']
            elapsed = time.time() * 1000 - previous.get('finished_at', 0)
            result = previous.get('result', {})
            if previous.get('action') != 'test' or previous.get('status') != 'complete' or not result.get('accepted') or result.get('delivery_verified') or not 15000 < elapsed < 1800000:
                continue
            count, last = DELIVERY_CHECKS.get(ident, (0, 0))
            if count >= 3 or time.time() - last < 30:
                continue
            DELIVERY_CHECKS[ident] = (count + 1, time.time())
            result = execute(inventory.get(previous['unit']), {**previous, 'action':'check', 'verify_test':True})
            if result.get('delivery_verified') is True:
                api('complete', {'id':ident, 'result':{'delivery_verified':True}})
            break
        return False
    # Record the intent before executing. After a restart its outcome is
    # uncertain, so finish it as interrupted rather than replaying the action.
    save_record(inflight, {key: job[key] for key in ('id', 'unit', 'action')})
    result = execute(inventory.get(job['unit']), job)
    save_record(pending, {'id': job['id'], 'result': result})
    finish_pending(pending, inflight)
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
