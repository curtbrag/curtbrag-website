#!/usr/bin/env python3
"""Inspect the current Termux launch permission without opening a real activity."""
import json
import os
import shutil
import subprocess

PROBE_COMPONENT = 'com.termux/com.termux.CurtClusterMissingPermissionProbe'


def inspect_controls(environ=None, run=None, which=None):
    environ = dict(os.environ if environ is None else environ)
    run = subprocess.run if run is None else run
    which = shutil.which if which is None else which
    report = dict(kind='phone-control-readiness', permission='unknown',
                  screen_verified=False, permissions_changed=False,
                  real_activity_requested=False, error=None)
    prefix = environ.get('PREFIX', '')
    expected = prefix + '/bin/am'
    if not (prefix.startswith('/data/') and prefix.endswith('/com.termux/files/usr')):
        report['error'] = 'This check runs only in the existing Termux worker.'
        return report
    if which('am', path=environ.get('PATH')) != expected:
        report['error'] = 'The installed Termux launcher is unavailable.'
        return report
    try:
        result = run([expected, 'start', '--user', '0', '--check-draw-over-apps-permission',
                      '-n', PROBE_COMPONENT], capture_output=True, text=True,
                     timeout=12, check=False, shell=False, env=environ)
        output = str(result.stdout or '') + '\n' + str(result.stderr or '')
        if 'requires the "Display over other apps" permission' in output:
            report['permission'] = 'required'
        elif 'does not exist' in output and PROBE_COMPONENT in output:
            report['permission'] = 'allowed'
        else:
            report['error'] = 'Android did not return a conclusive permission check.'
    except (OSError, subprocess.TimeoutExpired):
        report['error'] = 'The permission check did not finish.'
    return report


if __name__ == '__main__':
    print(json.dumps(inspect_controls(), separators=(',', ':')))
