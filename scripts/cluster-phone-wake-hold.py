#!/usr/bin/env python3
"""Keep the selected phone display on for ten minutes, without unlocking it."""
import fcntl
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys
import time

FOLDER = pathlib.Path('/data/data/com.termux/files/home/cluster/control/display-wake-20261022')
HELPER = FOLDER / 'curt-display-0b124dfbcc5c.dex'
SHA256 = '0b124dfbcc5c308dfd36c48248aa09b16863bbefe714d7befab500a0351f6b0c'
HOLD_MS = 600000


def private_file(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        raise ValueError('Unexpected display state file ownership or access.')
    return fd


def read_receipt(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    try:
        return json.loads(os.read(fd, 8192).split(b'\n', 1)[0])
    except (ValueError, IndexError):
        return {}


def holder_alive(value):
    pid = value.get('holder_pid')
    started = value.get('hold_started_ms')
    if (type(pid) is not int or pid <= 1 or type(started) is not int or
            not 0 <= time.time() * 1000 - started < HOLD_MS or
            value.get('hold_active') is not True or value.get('maximum_lock_ms') != HOLD_MS):
        return False
    try:
        process = pathlib.Path('/proc') / str(pid)
        command = (process / 'cmdline').read_bytes().split(b'\0')
        return (process.stat().st_uid == os.getuid() and b'CurtPhoneDisplay' in command
                and b'wake-hold' in command)
    except OSError:
        return False


def inspect():
    process = subprocess.run(['/system/bin/app_process', '/', 'CurtPhoneDisplay', 'inspect'],
        env={**os.environ, 'CLASSPATH': str(HELPER)}, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=8, check=False)
    value = json.loads(process.stdout)
    if process.returncode or value.get('error') or value.get('package_attribution_verified') is not True:
        raise ValueError('Independent screen-state check failed.')
    return value


def wake():
    if len(sys.argv) != 1 or os.getuid() < 10000:
        raise ValueError('Run through the existing Termux worker only.')
    info = HELPER.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('The private display helper has unexpected ownership or access.')
    if info.st_size != 11012 or hashlib.sha256(HELPER.read_bytes()).hexdigest() != SHA256:
        raise ValueError('The installed display helper does not match the reviewed version.')
    guard = private_file(FOLDER / 'hold-command.lock')
    log = None
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        log = private_file(FOLDER / 'hold-receipt.jsonl')
        value = read_receipt(log)
        reused = holder_alive(value)
        if not reused:
            os.ftruncate(log, 0)
            os.lseek(log, 0, os.SEEK_SET)
            child = subprocess.Popen(['/system/bin/app_process', '/', 'CurtPhoneDisplay', 'wake-hold'],
                env={**os.environ, 'CLASSPATH': str(HELPER)}, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                value = read_receipt(log)
                if holder_alive(value):
                    break
                if child.poll() is not None:
                    raise ValueError('Android did not start the bounded display hold.')
                time.sleep(0.2)
            else:
                child.terminate()
                raise ValueError('Display hold did not report readiness.')
        time.sleep(4)
        current = inspect()
        if not holder_alive(value) or current.get('interactive_after') is not True or current.get('display_state') != 2:
            raise ValueError('The screen did not remain on after wake.')
        if reused:
            value['interactive_before_request'] = True
            value['off_to_on_verified'] = False
        value.update(hold_reused=reused, hold_verified_at_ms=int(time.time()*1000),
            hold_until_ms=value['hold_started_ms'] + HOLD_MS, sustained_check_ms=4000)
        print(json.dumps(value, separators=(',', ':')))
        return 0
    finally:
        if log is not None:
            os.close(log)
        os.close(guard)


if __name__ == '__main__':
    try:
        sys.exit(wake())
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'kind': 'phone-display-wake', 'error': str(error)[:250]}))
        sys.exit(2)
