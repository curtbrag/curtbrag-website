"""Exercise the actual worker's CPU-lock guard without phones or network access."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / 'scripts/node-swarm.sh').read_text()
GUARD = SOURCE[SOURCE.index('LAST_WAKE_LOCK_REQUEST=0'):SOURCE.index('\ncleanup()')]
SHELL = (r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('sh'))

def shell_path(path):
    value = Path(path).resolve().as_posix()
    return '/' + value[0].lower() + value[2:] if os.name == 'nt' else value

@unittest.skipUnless(SHELL and Path(SHELL).exists(), 'POSIX shell required')
class WorkerWakeLockTest(unittest.TestCase):
    def run_guard(self, *, prefix='/data/data/com.termux/files/usr', enabled='1', fail=False):
        with tempfile.TemporaryDirectory(prefix='worker-wake-test-') as folder:
            root = Path(folder)
            tool = root / 'termux-wake-lock'
            tool.write_text('#!/bin/sh\nprintf "request\\n" >> "$TEST_REQUESTS"\nexit '+('1' if fail else '0')+'\n')
            tool.chmod(0o700)
            runner = root / 'check.sh'
            runner.write_text('log() { printf "LOG:%s\\n" "$1"; }\n'+GUARD+'''
for NOW in 1000 1060 1299 1300 1360 1601; do
  maintain_termux_wake_lock
  printf 'continued:%s\n' "$NOW"
done
''')
            env = dict(os.environ, PREFIX=prefix, TERMUX_CPU_WAKE_LOCK=enabled,
                       TEST_REQUESTS=shell_path(root/'requests'),
                       PATH=shell_path(root)+':/usr/bin:/bin' if os.name=='nt' else str(root)+os.pathsep+os.environ['PATH'])
            result = subprocess.run([SHELL, shell_path(runner)], env=env, capture_output=True,
                                    text=True, timeout=20,
                                    **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.count('continued:'), 6)
            count = len((root/'requests').read_text().splitlines()) if (root/'requests').exists() else 0
            return count, result.stdout

    def test_requests_on_start_and_at_five_minute_intervals(self):
        self.assertEqual(self.run_guard()[0], 3)

    def test_failure_does_not_stop_worker_or_create_retry_storm(self):
        count, output = self.run_guard(fail=True)
        self.assertEqual(count, 3)
        self.assertEqual(output.count('request failed'), 3)

    def test_linux_pc_does_not_request_phone_wake_lock(self):
        self.assertEqual(self.run_guard(prefix='/usr')[0], 0)

    def test_operator_can_opt_out(self):
        self.assertEqual(self.run_guard(enabled='0')[0], 0)

if __name__ == '__main__':
    unittest.main()
