"""Browser-opening safety/reporting tests, with no real navigation or network."""

import base64
import importlib.util
import io
import json
import pathlib
import stat
import subprocess
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("cluster_browser_open", pathlib.Path(__file__).resolve().parents[1] / "scripts" / "cluster-browser-open.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
URL = "https://curtbrag.com/cluster/?layout=wide&unit=phone191#activity"
TERMUX = {"PREFIX": "/data/data/com.termux/files/usr", "PATH": "/data/data/com.termux/files/usr/bin", "TERMUX_VERSION": "0.118"}
AM = "/data/data/com.termux/files/usr/bin/am"


class BrowserOpenTests(unittest.TestCase):
    def android(self, url=URL, completed=None, launcher=AM, run=None):
        run = run or Mock(return_value=completed or subprocess.CompletedProcess([], 0, "Starting: Intent", ""))
        report = helper.open_browser(url, environ=TERMUX, current_platform="linux", run=run, which=lambda *args, **kwargs: launcher)
        return report, run

    def linux(self, url=URL, environ=None, which=None, checker=None, proc_reader=None, completed=None):
        completed = completed or subprocess.CompletedProcess([], 0, "", "")
        process = Mock()
        process.wait.return_value = completed.returncode
        launch = Mock(return_value=process)
        launch.process_fixture = process
        environ = environ if environ is not None else {"PATH": "/usr/bin", "DISPLAY": ":0", "XAUTHORITY": "/home/user/.Xauthority"}
        which = which or (lambda name, **kwargs: "/usr/bin/xdg-open" if name == "xdg-open" else None)
        checker = checker or (lambda values, uid: values.get("DISPLAY") == ":0")
        proc_reader = proc_reader or (lambda uid: [])
        report = helper.open_browser(url, environ=environ, current_platform="linux", popen=launch, which=which, uid=1000,
                                     proc_reader=proc_reader, session_checker=checker)
        return report, launch

    def test_android_uses_termux_wrapper_argument_array_and_bounded_run(self):
        report, run = self.android()
        self.assertTrue(report["launch_requested"])
        self.assertEqual(report["state"], "launch-requested")
        self.assertEqual(report["kind"], "website-browser-open")
        self.assertFalse(report["visible_screen_verified"])
        self.assertEqual(report["platform"], "android")
        self.assertEqual(report["url"], URL)
        args, options = run.call_args
        self.assertEqual(args[0], [AM, "start", "--user", "0", "-a", "android.intent.action.VIEW",
                                   "-f", "0x18000000", "-d", URL])
        self.assertEqual(options["timeout"], 20)
        self.assertFalse(options["shell"])
        self.assertFalse(options["check"])
        self.assertEqual(options["env"], TERMUX)
        run.assert_called_once()

    def test_android_final_intent_flags_keep_new_task_and_multiple_task(self):
        # TermuxAm IntentCmd.java: -f uses setFlags(), while the named option
        # uses addFlags(). A later -f therefore erases previously added bits.
        # Source: github.com/termux/TermuxAm app/.../IntentCmd.java lines239-281.
        def termux_parser_flags(arguments):
            flags = 0
            for index, argument in enumerate(arguments):
                if argument == "-f":
                    flags = int(arguments[index + 1], 0)
                elif argument == "--activity-multiple-task":
                    flags |= 0x08000000
            return flags

        previous_arguments = ["--activity-multiple-task", "-f", "0x10000000"]
        self.assertEqual(termux_parser_flags(previous_arguments), 0x10000000)
        report, run = self.android()
        flags = termux_parser_flags(run.call_args.args[0])
        self.assertTrue(report["launch_requested"])
        self.assertEqual(flags & 0x10000000, 0x10000000)
        self.assertEqual(flags & 0x08000000, 0x08000000)
        self.assertEqual(flags, 0x18000000)

    def test_android_never_uses_system_am_or_installs_an_opener(self):
        for launcher in (None, "/system/bin/am", "/usr/bin/am"):
            with self.subTest(launcher=launcher):
                report, run = self.android(launcher=launcher)
                self.assertFalse(report["launch_requested"])
                self.assertIn("Termux", report["error"])
                run.assert_not_called()

    def test_android_zero_exit_errors_are_failures(self):
        messages = ["Error: Activity not started", "Error type 3", "java.lang.SecurityException: denied",
                    "Permission Denial: starting intent", "No activity found", "Unable to resolve intent",
                    "Background activity start denied"]
        for message in messages:
            with self.subTest(message=message):
                report, run = self.android(completed=subprocess.CompletedProcess([], 0, message, ""))
                self.assertFalse(report["launch_requested"])
                self.assertEqual(report["state"], "failed")
                self.assertFalse(report["visible_screen_verified"])
                self.assertIsNotNone(report["error"])
                run.assert_called_once()

    def test_intent_delivered_warning_is_only_launch_requested(self):
        report, _ = self.android(completed=subprocess.CompletedProcess([], 0, "Warning: Activity not started, intent has been delivered to currently running top-most instance.", ""))
        self.assertTrue(report["launch_requested"])
        self.assertFalse(report["visible_screen_verified"])

    def test_opener_nonzero_and_timeout_do_not_retry(self):
        report, run = self.android(completed=subprocess.CompletedProcess([], 1, "", "Browser unavailable"))
        self.assertFalse(report["launch_requested"])
        self.assertIn("exit 1", report["error"])
        run.assert_called_once()
        run = Mock(side_effect=subprocess.TimeoutExpired([AM], 20))
        report, run = self.android(run=run)
        self.assertFalse(report["launch_requested"])
        self.assertIn("20 seconds", report["error"])
        run.assert_called_once()

    def test_unsafe_urls_do_not_launch(self):
        urls = ["http://curtbrag.com/", "file:///tmp/test", "javascript:alert(1)", "https://user:pass@curtbrag.com/",
                "https://curtbrag.com:8443/", "https://localhost/", "https://device.local/", "https://device.internal/",
                "https://device.localdomain/", "https://device.home/", "https://device.lan/", "https://1.1.1.1/",
                "https://127.0.0.1/", "https://192.168.1.191/", "https://169.254.169.254/", "https://[::1]/",
                "https://[::ffff:127.0.0.1]/", "https://curtbrag.com/\nextra", "https://curtbrag.com\\@other.com/",
                "https://curtbrag.com./", "https://curtbrag.com/" + "a" * 2048,
                "https://curtbrag.com/" + "\U0001f680" * 300]
        for url in urls:
            with self.subTest(url=url):
                report, run = self.android(url)
                self.assertFalse(report["launch_requested"])
                self.assertIsNotNone(report["error"])
                run.assert_not_called()

    def test_query_and_fragment_are_preserved_without_shell_interpretation(self):
        url = "https://curtbrag.com/?name=$(touch%20/tmp/unsafe)&quote='value'#active"
        report, run = self.android(url)
        self.assertTrue(report["launch_requested"])
        self.assertEqual(report["url"], url)
        self.assertEqual(run.call_args.args[0][-1], url)
        self.assertFalse(run.call_args.kwargs["shell"])

    def test_public_hostname_normalization(self):
        self.assertEqual(helper.validate_url("HTTPS://CURTBRAG.COM:443"), "https://curtbrag.com/")
        self.assertEqual(helper.validate_url("https://curtbrag.com/caf\u00e9?q=\u00e9#\u00e9"), "https://curtbrag.com/caf%C3%A9?q=%C3%A9#%C3%A9")

    def test_empty_query_fragment_and_nested_fragment_hash_are_preserved(self):
        for suffix in ("?", "#", "?#", "#section#item"):
            url = "https://curtbrag.com/" + suffix
            with self.subTest(url=url):
                report, run = self.android(url)
                self.assertTrue(report["launch_requested"])
                self.assertEqual(report["url"], url)
                self.assertEqual(run.call_args.args[0][-1], url)

    def test_linux_existing_desktop_uses_xdg_open(self):
        report, run = self.linux()
        self.assertTrue(report["launch_requested"])
        self.assertFalse(report["visible_screen_verified"])
        self.assertEqual(run.call_args.args[0], ["/usr/bin/xdg-open", URL])
        self.assertEqual(run.call_args.kwargs["env"]["DISPLAY"], ":0")
        self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertTrue(run.call_args.kwargs["start_new_session"])
        run.process_fixture.wait.assert_called_once_with(timeout=3)
        self.assertTrue(report["opener_completed"])
        self.assertFalse(run.call_args.kwargs["shell"])

    def test_linux_prefers_gio_and_uses_argument_array(self):
        report, run = self.linux(which=lambda name, **kwargs: "/usr/bin/" + name)
        self.assertTrue(report["launch_requested"])
        self.assertEqual(run.call_args.args[0], ["/usr/bin/gio", "open", URL])

    def test_long_lived_linux_opener_is_not_killed_and_has_no_pipes(self):
        process = Mock()
        process.wait.side_effect = subprocess.TimeoutExpired(["/usr/bin/xdg-open"], 3)
        launch = Mock(return_value=process)
        android_run = Mock()
        report = helper.open_browser(
            URL, environ={"PATH": "/usr/bin", "DISPLAY": ":0"}, current_platform="linux", uid=1000,
            popen=launch, run=android_run, which=lambda name, **kwargs: "/usr/bin/xdg-open" if name == "xdg-open" else None,
            session_checker=lambda values, uid: True, proc_reader=lambda uid: [],
        )
        self.assertTrue(report["launch_requested"])
        self.assertEqual(report["state"], "launch-requested")
        self.assertFalse(report["opener_completed"])
        self.assertFalse(report["visible_screen_verified"])
        self.assertIsNone(report["error"])
        launch.assert_called_once()
        process.wait.assert_called_once_with(timeout=3)
        process.kill.assert_not_called()
        process.terminate.assert_not_called()
        process.communicate.assert_not_called()
        android_run.assert_not_called()
        for stream in ("stdin", "stdout", "stderr"):
            self.assertEqual(launch.call_args.kwargs[stream], subprocess.DEVNULL)
        self.assertTrue(launch.call_args.kwargs["close_fds"])

    def test_linux_immediate_failure_is_reported_without_retry_or_termination(self):
        report, launch = self.linux(completed=subprocess.CompletedProcess([], 4, "", ""))
        self.assertFalse(report["launch_requested"])
        self.assertEqual(report["state"], "failed")
        self.assertIn("exit 4", report["error"])
        launch.assert_called_once()
        launch.process_fixture.kill.assert_not_called()
        launch.process_fixture.terminate.assert_not_called()
        launch.process_fixture.communicate.assert_not_called()

    def test_linux_no_graphical_session_does_not_guess_or_launch(self):
        report, run = self.linux(environ={"PATH": "/usr/bin", "DISPLAY": "localhost:10.0"}, checker=lambda values, uid: False)
        self.assertFalse(report["launch_requested"])
        self.assertIn("No verified graphical", report["error"])
        run.assert_not_called()

    def test_linux_missing_opener_reports_unsupported(self):
        report, run = self.linux(which=lambda *args, **kwargs: None)
        self.assertFalse(report["launch_requested"])
        self.assertIn("No existing", report["error"])
        run.assert_not_called()

    def test_linux_uses_only_selected_session_environment_and_clears_stale_ssh_values(self):
        own_session = {"DISPLAY": ":0", "XAUTHORITY": "/home/user/session-auth", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus", "TOKEN": "must-not-copy"}
        report, run = self.linux(
            environ={"PATH": "/usr/bin", "DISPLAY": "localhost:10.0", "WAYLAND_DISPLAY": "stale", "XAUTHORITY": "old"},
            proc_reader=lambda uid: [own_session],
        )
        self.assertTrue(report["launch_requested"])
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["DISPLAY"], ":0")
        self.assertEqual(env["XAUTHORITY"], "/home/user/session-auth")
        self.assertNotIn("WAYLAND_DISPLAY", env)
        self.assertNotIn("TOKEN", env)
        self.assertNotIn("must-not-copy", json.dumps(report))

    def test_graphical_environment_requires_real_local_socket(self):
        directory = types.SimpleNamespace(st_mode=stat.S_IFDIR, st_uid=1000)
        socket_info = types.SimpleNamespace(st_mode=stat.S_IFSOCK, st_uid=1000)
        regular = types.SimpleNamespace(st_mode=stat.S_IFREG, st_uid=1000)
        paths = {"/run/user/1000": directory, "/run/user/1000/wayland-0": socket_info, "/tmp/.X11-unix/X0": socket_info}
        with patch.object(helper.os, "stat", side_effect=lambda path: paths[path]):
            self.assertTrue(helper.valid_graphical_environment({"XDG_RUNTIME_DIR": "/run/user/1000", "WAYLAND_DISPLAY": "wayland-0"}, 1000))
            self.assertTrue(helper.valid_graphical_environment({"DISPLAY": ":0.0"}, 1000))
            self.assertFalse(helper.valid_graphical_environment({"DISPLAY": "localhost:10.0"}, 1000))
            self.assertFalse(helper.valid_graphical_environment({"XDG_RUNTIME_DIR": "/run/user/1000", "WAYLAND_DISPLAY": "wayland-0"}, 999))
            paths["/tmp/.X11-unix/X0"] = regular
            self.assertFalse(helper.valid_graphical_environment({"DISPLAY": ":0"}, 1000))

    def test_proc_scan_only_same_uid_desktop_processes_and_relevant_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for pid, comm, env in (
                ("11", "plasmashell", b"DISPLAY=:0\0TOKEN=secret\0XAUTHORITY=/home/user/auth\0"),
                ("12", "unrelated", b"DISPLAY=:77\0PASSWORD=secret\0"),
                ("13", "gnome-shell", b"DISPLAY=:99\0TOKEN=other-user\0"),
            ):
                process = root / pid
                process.mkdir()
                (process / "comm").write_text(comm)
                (process / "environ").write_bytes(env)
            own_uid = (root / "11").stat().st_uid
            original_stat = pathlib.Path.stat

            def process_owner(path, *args, **kwargs):
                if path == root / "13":
                    return types.SimpleNamespace(st_uid=own_uid + 1)
                return original_stat(path, *args, **kwargs)

            with patch.object(pathlib.Path, "stat", process_owner):
                values = list(helper.own_desktop_environments(own_uid, str(root)))
            self.assertEqual(values, [{"DISPLAY": ":0", "XAUTHORITY": "/home/user/auth"}])

    def test_other_platform_is_explicitly_unsupported(self):
        run = Mock()
        report = helper.open_browser(URL, environ={}, current_platform="win32", run=run)
        self.assertFalse(report["launch_requested"])
        self.assertEqual(report["platform"], "win32")
        self.assertIn("Android Termux and Linux", report["error"])
        run.assert_not_called()

    def test_cli_exact_encoded_settings_and_json_exit_contract(self):
        encoded = base64.b64encode(json.dumps({"url": URL}).encode()).decode()
        accepted = {"kind": "website-browser-open", "url": URL, "launch_requested": True, "state": "launch-requested", "visible_screen_verified": False}
        with patch("sys.argv", ["worker", "--settings-b64", encoded]), patch.object(helper, "open_browser", return_value=accepted) as navigate, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(helper.main(), 0)
        navigate.assert_called_once_with(URL)
        self.assertEqual(json.loads(output.getvalue()), accepted)
        for invalid in ("invalid!!!", base64.b64encode(b'{"url":"https://curtbrag.com/","autoplay":true}').decode()):
            with self.subTest(invalid=invalid), patch("sys.argv", ["worker", "--settings-b64", invalid]), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(helper.main(), 1)
                report = json.loads(output.getvalue())
                self.assertEqual(report["state"], "failed")
                self.assertFalse(report["launch_requested"])
                self.assertFalse(report["visible_screen_verified"])
                self.assertEqual(report["error"], "Invalid encoded URL settings.")


if __name__ == "__main__":
    unittest.main(verbosity=2)
