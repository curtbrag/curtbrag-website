#!/usr/bin/env python3
"""Run the approved phone worker's reviewed, already-installed display helper. No installer."""
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys

HELPER = pathlib.Path('/data/data/com.termux/files/home/cluster/control/display-wake-20261022/curt-display-3f387f25f6e8.dex')
SHA256 = '3f387f25f6e895e296aaa48206b5bd147cf6c51ddfe14e4cfa8014c1b7a0d3ae'


def wake():
    if len(sys.argv) != 1 or os.getuid() < 10000:
        raise ValueError('Run through the existing Termux worker only.')
    info = HELPER.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('The private display helper has unexpected ownership or access.')
    if info.st_size != 9884 or hashlib.sha256(HELPER.read_bytes()).hexdigest() != SHA256:
        raise ValueError('The installed display helper does not match the reviewed version.')
    result = subprocess.run(
        ['/system/bin/app_process', '/', 'CurtPhoneDisplay', 'wake'],
        env={**os.environ, 'CLASSPATH': str(HELPER)}, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=12, check=False,
    )
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or value.get('kind') != 'phone-display-wake':
        raise ValueError('The phone returned an unexpected display report.')
    print(json.dumps(value, separators=(',', ':')))
    return result.returncode


if __name__ == '__main__':
    try:
        sys.exit(wake())
    except (OSError, ValueError, subprocess.TimeoutExpired):
        print(json.dumps({'kind': 'phone-display-wake', 'error': 'Display wake could not be verified. Check the installed display helper and existing connection.'}))
        sys.exit(2)
