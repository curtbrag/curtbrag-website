"""Browser-opening safety/reporting tests, with no real navigation or network."""

import base64
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
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


def native_receipt(action="open-website", url=URL, raw=0, **changes):
    receipt = {"kind": "cluster-android-start-result", "action": action, "uid": 10191,
               "user_id": 0, "sdk": 35, "calling_package": "com.termux", "package_attribution_verified": True,
               "caller_thread_is_null": True, "options_are_null": True, "maximum_activity_requests": 1,
               "no_retry": True, "permissions_changed": False, "settings_changed": False,
               "identity_changed": False, "visible_screen_verified": False, "activity_request_entered": True,
               "wait_result_received": True, "raw_start_result": raw,
               "classification": {0:"START_SUCCESS", 2:"START_TASK_TO_FRONT", 3:"START_DELIVERED_TO_TOP",102:"START_ABORTED"}.get(raw,"UNRECOGNIZED_RESULT"),
               "wait_timed_out": False, "reported_component": "org.lineageos.jelly/.MainActivity" if action=="open-website" else "com.termux/.app.TermuxActivity",
               "reported_total_time_ms": 10}
    if action == "open-website": receipt["url"] = url
    elif action == "return-termux":
        receipt["termux_visibility"] = {"query_succeeded":True, "task_snapshot_complete":True, "focused_visible_termux_task_count":1}
    receipt.update(changes)
    return receipt


class BrowserOpenTests(unittest.TestCase):
    def android(self, url=URL, completed=None, launcher=None, run=None):
        try:
            normalized = helper.validate_url(url)
        except helper.LaunchError:
            normalized = url
        run = run or Mock(return_value=completed or subprocess.CompletedProcess([], 0, json.dumps(native_receipt(url=normalized)), ""))
        report = helper.open_browser(url, environ=TERMUX, current_platform="linux", run=run,
                                     uid=10191, native_prepare=lambda env, uid: "/private/pinned.dex")
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









    def test_unsafe_urls_do_not_launch(self):
        urls = ["http://curtbrag.com/", "file:///tmp/test", "javascript:alert(1)", "https://user:pass@curtbrag.com/",
                "https://curtbrag.com:8443/", "https://localhost/", "https://device.local/", "https://device.internal/",
                "https://device.localdomain/", "https://device.home/", "https://device.lan/", "https://1.1.1.1/",
                "https://127.0.0.1/", "https://127.1/", "https://0177.0.0.1/", "https://192.168.1.191/", "https://169.254.169.254/", "https://[::1]/",
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


class TermuxReturnTests(unittest.TestCase):




    def test_desktop_return_does_not_open_or_close_any_program(self):
        for platform in ("linux", "linux2", "win32", "darwin"):
            with self.subTest(platform=platform):
                run = Mock()
                opener = Mock()
                locator = Mock()
                with patch.object(helper.subprocess, "Popen", opener):
                    report = helper.return_termux(environ={"PATH": "/usr/bin", "DISPLAY": ":0"},
                                                  current_platform=platform, run=run, which=locator)
                self.assertEqual(report["state"], "failed")
                self.assertFalse(report["return_requested"])
                self.assertFalse(report["request_completed"])
                self.assertFalse(report["visible_screen_verified"])
                self.assertIn("only on Android Termux phones", report["error"])
                run.assert_not_called()
                opener.assert_not_called()
                locator.assert_not_called()






    def test_cli_exact_return_settings_route_and_success_exit_contract(self):
        encoded = base64.b64encode(json.dumps({"action": "return-termux"}).encode()).decode()
        accepted = {"kind": "phone-termux-return", "return_requested": True, "request_completed": True,
                    "state": "termux-foreground", "foreground_app_verified": True, "visible_screen_verified": False}
        with patch("sys.argv", ["worker", "--settings-b64", encoded]), \
                patch.object(helper, "return_termux", return_value=accepted) as return_app, \
                patch.object(helper, "open_browser") as navigate, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(helper.main(), 0)
        return_app.assert_called_once_with()
        navigate.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), accepted)

    def test_cli_return_failure_reports_failure_exit_without_retry(self):
        encoded = base64.b64encode(json.dumps({"action": "return-termux"}).encode()).decode()
        failed = {"kind": "phone-termux-return", "return_requested": False, "request_completed": True,
                  "state": "failed", "visible_screen_verified": False, "error": "Android rejected return"}
        with patch("sys.argv", ["worker", "--settings-b64", encoded]), \
                patch.object(helper, "return_termux", return_value=failed) as return_app, \
                patch.object(helper, "open_browser") as navigate, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(helper.main(), 1)
        return_app.assert_called_once_with()
        navigate.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()), failed)

    def test_cli_return_settings_reject_extra_parameters_and_other_actions_without_side_effects(self):
        settings_variants = [
            {"action": "return-termux", "url": URL},
            {"action": "return-termux", "component": "com.other/.Activity"},
            {"action": "return-termux", "flags": "0xffffffff"},
            {"action": "return-termux", "delay": 60},
            {"action": "return-termux", "close_browser": True},
            {"action": "return-termux", "grant": "SYSTEM_ALERT_WINDOW"},
            {"action": "return-termux; arbitrary-command"}, {"action": "open-browser"},
            {"action": None}, {"action": True}, {"action": ["return-termux"]},
            {"action": {"name": "return-termux"}}, {}, None, ["return-termux"],
        ]
        for settings in settings_variants:
            encoded = base64.b64encode(json.dumps(settings).encode()).decode()
            with self.subTest(settings=settings), patch("sys.argv", ["worker", "--settings-b64", encoded]), \
                    patch.object(helper, "return_termux") as return_app, \
                    patch.object(helper.subprocess, "run") as run, \
                    patch.object(helper.subprocess, "Popen") as opener, redirect_stdout(io.StringIO()) as output:
                self.assertEqual(helper.main(), 1)
                report = json.loads(output.getvalue())
                self.assertEqual(report["state"], "failed")
                self.assertFalse(report["launch_requested"])
                self.assertFalse(report["visible_screen_verified"])
                self.assertEqual(report["error"], "Invalid encoded URL settings.")
                return_app.assert_not_called()
                run.assert_not_called()
                opener.assert_not_called()

    def test_cli_malformed_or_oversized_settings_never_return_or_navigate(self):
        for invalid in ("invalid!!!", base64.b64encode(b"\xff").decode(), base64.b64encode(b"{").decode(), "a" * 16385):
            with self.subTest(invalid=invalid[:30]), patch("sys.argv", ["worker", "--settings-b64", invalid]), \
                    patch.object(helper, "return_termux") as return_app, \
                    patch.object(helper.subprocess, "run") as run, \
                    patch.object(helper.subprocess, "Popen") as opener, redirect_stdout(io.StringIO()) as output:
                self.assertEqual(helper.main(), 1)
                report = json.loads(output.getvalue())
                self.assertEqual(report["error"], "Invalid encoded URL settings.")
                return_app.assert_not_called()
                run.assert_not_called()
                opener.assert_not_called()


class AndroidNativeReceiptTests(unittest.TestCase):
    def request(self, action="open-website", receipt=None, completed=None, run=None, prepare=None, **options):
        if completed is None:
            completed = subprocess.CompletedProcess([], 0, json.dumps(receipt if receipt is not None else native_receipt(action)), "")
        run = run or Mock(return_value=completed)
        prepare = prepare or Mock(return_value="/private/pinned.dex")
        arguments = dict(environ=TERMUX, current_platform="linux", run=run, uid=10191,
                         native_prepare=prepare)
        arguments.update(options)
        report = helper.open_browser(URL, **arguments) if action == "open-website" else helper.return_termux(**arguments)
        return report, run, prepare

    def test_same_uid_native_array_is_bounded_and_has_no_am_fallback_or_shell(self):
        locator = Mock()
        report, run, prepare = self.request(which=locator)
        self.assertTrue(report["launch_requested"])
        self.assertFalse(report["visible_screen_verified"])
        self.assertEqual(run.call_args.args[0], ["/system/bin/app_process", "/", "CurtStartActivityWait", "open-website", URL])
        options = run.call_args.kwargs
        self.assertEqual(options["timeout"], 15)
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(options["env"]["CLASSPATH"], "/private/pinned.dex")
        self.assertFalse(options["shell"])
        self.assertFalse(options["check"])
        run.assert_called_once()
        prepare.assert_called_once_with(TERMUX, 10191)
        locator.assert_not_called()

    def test_both_actions_report_raw102_as_blocked_even_with_zero_process_exit(self):
        for action in ("open-website", "return-termux"):
            with self.subTest(action=action):
                report, run, _ = self.request(action, native_receipt(action, raw=102, reported_component=None))
                self.assertEqual(report["state"], "failed")
                self.assertFalse(report.get("launch_requested", report.get("return_requested")))
                self.assertEqual(report["error_code"], "android-background-launch-blocked")
                self.assertEqual(report["android_start"]["raw_start_result"], 102)
                self.assertIn("START_ABORTED", report["error"])
                self.assertFalse(report["visible_screen_verified"])
                run.assert_called_once()

    def test_cli_turns_zero_exit_native_background_abort_into_failed_worker_receipt(self):
        encoded = base64.b64encode(json.dumps({"url":URL}).encode()).decode()
        run = Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps(native_receipt(raw=102, reported_component=None)), ""))
        with patch.dict(helper.os.environ, TERMUX, clear=True), \
                patch.object(helper.os, "getuid", return_value=10191, create=True), \
                patch.object(helper, "android_native_cache", return_value="/private/pinned.dex"), \
                patch.object(helper.subprocess, "run", run), \
                patch("sys.argv", ["worker", "--settings-b64", encoded]), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(helper.main(), 1)
        report = json.loads(output.getvalue())
        self.assertEqual(report["error_code"], "android-background-launch-blocked")
        self.assertEqual(report["android_start"]["raw_start_result"], 102)
        self.assertFalse(report["launch_requested"])
        run.assert_called_once()

    def test_positive_android_results_require_own_focused_visible_task_for_return(self):
        for action in ("open-website", "return-termux"):
            for raw in (0, 2, 3):
                with self.subTest(action=action, raw=raw):
                    report, run, _ = self.request(action, native_receipt(action, raw=raw))
                    self.assertTrue(report.get("launch_requested", report.get("return_requested")))
                    self.assertFalse(report["visible_screen_verified"])
                    self.assertIsNone(report["error"])
                    self.assertEqual(report["android_start"]["raw_start_result"], raw)
                    if action == "return-termux":
                        self.assertEqual(report["state"], "termux-foreground")
                        self.assertTrue(report["foreground_app_verified"])
                        self.assertTrue(report["termux_visibility"]["query_succeeded"])
                    else:
                        self.assertEqual(report["state"], "launch-requested")
                        self.assertNotIn("termux_visibility", report)
                    run.assert_called_once()

    def test_delivered_return_that_is_not_focused_and_visible_is_failed_without_retry(self):
        for raw in (0, 2, 3):
            receipt = native_receipt("return-termux", raw=raw, termux_visibility={
                "query_succeeded":True,"task_snapshot_complete":True,"focused_visible_termux_task_count":0})
            report, run, _ = self.request("return-termux", receipt)
            self.assertTrue(report["return_requested"])
            self.assertTrue(report["request_completed"])
            self.assertEqual(report["state"], "failed")
            self.assertFalse(report["foreground_app_verified"])
            self.assertEqual(report["error_code"], "android-termux-not-foreground")
            self.assertFalse(report["visible_screen_verified"])
            run.assert_called_once()

    def test_return_visibility_unknown_timeout_truncated_and_wrong_types_cannot_verify_foreground(self):
        variants = [None, [], {},
                    {"query_succeeded":False,"task_snapshot_complete":False,"focused_visible_termux_task_count":0},
                    {"query_succeeded":True,"task_snapshot_complete":False,"focused_visible_termux_task_count":1},
                    {"query_succeeded":True,"task_snapshot_complete":True,"focused_visible_termux_task_count":True},
                    {"query_succeeded":True,"task_snapshot_complete":True,"focused_visible_termux_task_count":-1},
                    {"query_succeeded":True,"task_snapshot_complete":True,"focused_visible_termux_task_count":17},
                    {"query_succeeded":True,"task_snapshot_complete":True,"focused_visible_termux_task_count":1,"query_timed_out":True},
                    # Separate flags must not replace a joint count from the same task.
                    {"query_succeeded":True,"task_snapshot_complete":True,"visible":True,"focused":True}]
        for visibility in variants:
            with self.subTest(visibility=visibility):
                report, run, _ = self.request("return-termux", native_receipt("return-termux", raw=3, termux_visibility=visibility))
                self.assertEqual(report["state"], "failed")
                self.assertTrue(report["return_requested"])
                self.assertFalse(report["foreground_app_verified"])
                self.assertEqual(report["error_code"], "android-return-unconfirmed")
                run.assert_called_once()

    def test_return_foreground_claim_requires_matching_activity_receipt(self):
        for changes in (dict(reported_component="com.other/.Activity"), dict(uid=2000), dict(calling_package="com.other"),
                        dict(raw_start_result=102, classification="START_ABORTED"), dict(wait_timed_out=True)):
            report, run, _ = self.request("return-termux", native_receipt("return-termux", **changes))
            self.assertEqual(report["state"], "failed")
            self.assertFalse(report["foreground_app_verified"])
            run.assert_called_once()

    def test_cli_hidden_delivered_return_is_exit1_and_only_verified_foreground_is_exit0(self):
        encoded = base64.b64encode(json.dumps({"action":"return-termux"}).encode()).decode()
        for count, exit_code in ((0,1),(1,0)):
            receipt = native_receipt("return-termux", raw=3, termux_visibility={
                "query_succeeded":True,"task_snapshot_complete":True,"focused_visible_termux_task_count":count})
            run = Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(receipt),""))
            with self.subTest(count=count), patch.dict(helper.os.environ, TERMUX, clear=True), \
                    patch.object(helper.os,"getuid",return_value=10191,create=True), \
                    patch.object(helper,"android_native_cache",return_value="/private/pinned.dex"), \
                    patch.object(helper.subprocess,"run",run), \
                    patch("sys.argv",["worker","--settings-b64",encoded]), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(helper.main(),exit_code)
            report = json.loads(output.getvalue())
            self.assertTrue(report["return_requested"])
            self.assertEqual(report["foreground_app_verified"],count>0)
            self.assertFalse(report["visible_screen_verified"])
            run.assert_called_once()

    def test_return_command_has_no_external_url_or_arbitrary_component_parameter(self):
        report, run, _ = self.request("return-termux")
        self.assertEqual(run.call_args.args[0], ["/system/bin/app_process", "/", "CurtStartActivityWait", "return-termux"])
        self.assertTrue(report["return_requested"])
        self.assertNotIn("url", report)
        self.assertIn("Browser is not closed", report["scope"])

    def test_missing_receipts_legacy_am_text_and_malformed_json_never_become_success(self):
        for text in ("Starting: Intent", "", "null", "[]", "{", '"START_SUCCESS"', "x"*16385):
            with self.subTest(text=text[:20]):
                report, run, _ = self.request(completed=subprocess.CompletedProcess([], 0, text, ""))
                self.assertFalse(report["launch_requested"])
                self.assertEqual(report["error_code"], "android-launch-unconfirmed")
                run.assert_called_once()

    def test_timeout_unknown_raw_invalid_component_and_wrong_attribution_never_retry(self):
        variants = [dict(raw_start_result=999, classification="UNRECOGNIZED_RESULT"),
                    dict(raw_start_result=True), dict(wait_timed_out=True), dict(wait_result_received=False),
                    dict(reported_component=None), dict(reported_component="invalid"),
                    dict(binder_call_timed_out=True), dict(error_class="java.lang.SecurityException"),
                    dict(uid=2000), dict(user_id=1), dict(sdk=34), dict(action="return-termux"),
                    dict(package_attribution_verified=False), dict(options_are_null=False),
                    dict(calling_package="com.other"), dict(permissions_changed=True),
                    dict(url="https://other.example.com/"), dict(no_retry=False)]
        for variant in variants:
            with self.subTest(variant=variant):
                report, run, _ = self.request(receipt=native_receipt(**variant))
                self.assertFalse(report["launch_requested"])
                self.assertEqual(report["error_code"], "android-launch-unconfirmed")
                run.assert_called_once()
        for action in ("open-website", "return-termux"):
            run = Mock(side_effect=subprocess.TimeoutExpired(["app_process"], 15))
            report, run, _ = self.request(action, run=run)
            self.assertEqual(report["error_code"], "android-launch-unconfirmed")
            self.assertIn("No retry", report["error"])
            run.assert_called_once()

    def test_nonzero_process_is_unconfirmed_even_with_otherwise_positive_wait_result(self):
        report, run, _ = self.request(completed=subprocess.CompletedProcess([], 2, json.dumps(native_receipt()), ""))
        self.assertFalse(report["launch_requested"])
        self.assertEqual(report["error_code"], "android-launch-unconfirmed")
        run.assert_called_once()

    def test_fixed_return_rejects_unexpected_reported_component(self):
        report, run, _ = self.request("return-termux", native_receipt("return-termux", reported_component="com.other/.Activity"))
        self.assertFalse(report["return_requested"])
        run.assert_called_once()

    def test_failed_cache_or_non_app_uid_stops_before_any_activity_request(self):
        for options in (dict(uid=0), dict(uid=2000), dict(uid=9999),
                        dict(environ={"TERMUX_VERSION":"0.118","PREFIX":"/usr"})):
            report, run, prepare = self.request(**options)
            self.assertFalse(report["launch_requested"])
            run.assert_not_called()
            prepare.assert_not_called()
        prepare = Mock(side_effect=helper.LaunchError("Pinned code cache did not verify"))
        report, run, _ = self.request(prepare=prepare)
        self.assertIn("cache", report["error"])
        run.assert_not_called()

    def test_environment_does_not_inherit_loader_overrides(self):
        env = dict(TERMUX, LD_PRELOAD="untrusted", LD_LIBRARY_PATH="untrusted", CLASSPATH="untrusted")
        report, run, _ = self.request(environ=env)
        self.assertTrue(report["launch_requested"])
        self.assertNotIn("LD_PRELOAD", run.call_args.kwargs["env"])
        self.assertNotIn("LD_LIBRARY_PATH", run.call_args.kwargs["env"])
        self.assertEqual(run.call_args.kwargs["env"]["CLASSPATH"], "/private/pinned.dex")

    def test_public_native_payload_matches_reproducible_source_manifest(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        manifest = json.loads((root/"scripts/android/cluster-browser-open-build.json").read_text())
        data = base64.b64decode(helper.ANDROID_NATIVE_DEX_B64, validate=True)
        self.assertEqual(hashlib.sha256(data).hexdigest(), helper.ANDROID_NATIVE_SHA256)
        self.assertEqual(helper.ANDROID_NATIVE_SHA256, manifest["dex_sha256"])
        self.assertEqual(len(data), manifest["dex_bytes"])
        source = (root/manifest["source"]).read_text().replace("\r\n", "\n").encode()
        self.assertEqual(hashlib.sha256(source).hexdigest(), manifest["source_sha256"])
        self.assertFalse(manifest["apk_install_required"])

    def test_native_visibility_requires_focus_and_visibility_on_the_same_exact_termux_task(self):
        configured = pathlib.Path(os.environ["CURT_TEST_JDK_BIN"]) if os.environ.get("CURT_TEST_JDK_BIN") else None
        javac = str(configured/"javac.exe") if configured else shutil.which("javac")
        java = str(configured/"java.exe") if configured else shutil.which("java")
        if not javac or not java:
            self.skipTest("JDK is required for the read-only Android task fixtures")
        sources = {
            "android/content/ComponentName.java": r'''
package android.content;
public final class ComponentName {
  private final String pkg, name;
  public ComponentName(String pkg, String name) { this.pkg=pkg; this.name=name; }
  public String getPackageName() { return pkg; }
  public String getClassName() { return name; }
}
''',
            "android/app/ActivityManager.java": r'''
package android.app;
import java.util.List;
import android.content.ComponentName;
public final class ActivityManager {
  public final List<List<AppTask>> snapshots;
  public int reads=0;
  public ActivityManager(List<List<AppTask>> snapshots) { this.snapshots=snapshots; }
  public List<AppTask> getAppTasks() { return snapshots.get(Math.min(reads++,snapshots.size()-1)); }
  public static final class AppTask {
    private final TaskInfo info;
    public AppTask(TaskInfo info) { this.info=info; }
    public TaskInfo getTaskInfo() { return info; }
  }
  public static final class TaskInfo {
    public ComponentName topActivity;
    public boolean isVisible, isFocused;
    public int displayId=0;
    public boolean isSleeping=false;
    public TaskInfo(String pkg, String name, boolean visible, boolean focused) {
      topActivity=new ComponentName(pkg,name); isVisible=visible; isFocused=focused;
    }
  }
}
''',
            "VisibilityHarness.java": r'''
import java.lang.reflect.Method;
import java.util.*;
import android.app.ActivityManager;
public final class VisibilityHarness {
  static final String TERMUX="com.termux.app.TermuxActivity";
  public static final class FixtureContext {
    final ActivityManager manager;
    public FixtureContext(ActivityManager manager) { this.manager=manager; }
    public Object getSystemService(String name) { return manager; }
  }
  static ActivityManager.AppTask task(String pkg,String name,boolean visible,boolean focused) {
    return new ActivityManager.AppTask(new ActivityManager.TaskInfo(pkg,name,visible,focused));
  }
  static ActivityManager.AppTask displayTask(int displayId,boolean sleeping) {
    ActivityManager.TaskInfo info=new ActivityManager.TaskInfo("com.termux",TERMUX,true,true);
    info.displayId=displayId; info.isSleeping=sleeping;
    return new ActivityManager.AppTask(info);
  }
  static void sample(String name,List<ActivityManager.AppTask>... snapshots) throws Exception {
    ActivityManager manager=new ActivityManager(Arrays.asList(snapshots));
    Method inspect=CurtStartActivityWait.class.getDeclaredMethod("boundedTermuxVisibility",Class.class,Object.class);
    inspect.setAccessible(true);
    String result=(String)inspect.invoke(null,FixtureContext.class,new FixtureContext(manager));
    System.out.println(name+"\t"+result+"\t"+manager.reads);
  }
  public static void main(String[] args) throws Exception {
    List<ActivityManager.AppTask> unfocused=Arrays.asList(task("com.termux",TERMUX,true,false));
    sample("visible_unfocused",unfocused);
    sample("focused_hidden",Arrays.asList(task("com.termux",TERMUX,false,true)));
    sample("split_tasks",Arrays.asList(task("com.termux",TERMUX,true,false),task("com.termux",TERMUX,false,true)));
    sample("wrong_component",Arrays.asList(task("com.other","com.other.Activity",true,true),task("com.termux","com.termux.SettingsActivity",true,true)));
    sample("other_display",Arrays.asList(displayTask(1,false)));
    sample("sleeping_task",Arrays.asList(displayTask(0,true)));
    List<ActivityManager.AppTask> focused=Arrays.asList(task("com.termux",TERMUX,true,true));
    sample("verified",focused);
    sample("transition",unfocused,focused);
    List<ActivityManager.AppTask> truncated=new ArrayList<ActivityManager.AppTask>();
    for(int i=0;i<17;i++)truncated.add(task("com.termux",TERMUX,true,true));
    sample("truncated",truncated);
    sample("unknown",(List<ActivityManager.AppTask>)null);
  }
}
'''}
        root = pathlib.Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            folder = pathlib.Path(directory)
            paths = []
            for name, contents in sources.items():
                path = folder/name
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_text(contents,encoding="utf-8")
                paths.append(str(path))
            paths.append(str(root/"scripts/android/CurtStartActivityWait.java"))
            options = {"capture_output":True,"text":True,"timeout":30,"check":False}
            if os.name == "nt": options["creationflags"] = subprocess.CREATE_NO_WINDOW
            built = subprocess.run([javac,"--release","8","-d",str(folder),*paths],**options)
            self.assertEqual(built.returncode,0,built.stderr)
            checked = subprocess.run([java,"-cp",str(folder),"VisibilityHarness"],**options)
            self.assertEqual(checked.returncode,0,checked.stderr)
            cases = {name:(json.loads(result),int(reads)) for name,result,reads in (line.split("\t") for line in checked.stdout.splitlines())}
        self.assertEqual(set(cases),{"visible_unfocused","focused_hidden","split_tasks","wrong_component","other_display","sleeping_task","verified","transition","truncated","unknown"})
        for name in ("visible_unfocused","focused_hidden","split_tasks","wrong_component","other_display","sleeping_task"):
            self.assertEqual(cases[name][0]["focused_visible_termux_task_count"],0)
            self.assertEqual(cases[name][1],4)
        self.assertEqual(cases["verified"][0]["focused_visible_termux_task_count"],1)
        self.assertEqual(cases["verified"][1],1)
        self.assertEqual(cases["transition"][0]["focused_visible_termux_task_count"],1)
        self.assertEqual(cases["transition"][1],2)
        self.assertFalse(cases["truncated"][0]["task_snapshot_complete"])
        self.assertEqual(cases["truncated"][1],1)
        self.assertFalse(cases["unknown"][0]["query_succeeded"])
        self.assertEqual(cases["unknown"][1],1)

    @unittest.skipUnless(hasattr(os, "O_DIRECTORY") and hasattr(os, "O_NOFOLLOW") and hasattr(os, "getuid"), "POSIX cache descriptor guards")
    def test_cache_is_private_pinned_and_rejects_tamper_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            env = {"HOME":directory}
            path = pathlib.Path(helper.android_native_cache(env, os.getuid()))
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
            self.assertEqual(helper.android_native_cache(env, os.getuid()), str(path))
            original = path.read_bytes()
            path.chmod(0o600)
            path.write_bytes(b"x"*len(original))
            path.chmod(0o400)
            with self.assertRaises(helper.LaunchError): helper.android_native_cache(env, os.getuid())
            self.assertEqual(path.read_bytes(), b"x"*len(original))

    @unittest.skipUnless(hasattr(os, "O_DIRECTORY") and hasattr(os, "O_NOFOLLOW") and hasattr(os, "getuid"), "POSIX cache descriptor guards")
    def test_cache_rejects_symlinked_parent_and_never_reads_other_directory(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as elsewhere:
            os.chmod(directory, 0o700)
            (pathlib.Path(directory)/"cluster").symlink_to(elsewhere, target_is_directory=True)
            with self.assertRaises(helper.LaunchError): helper.android_native_cache({"HOME":directory}, os.getuid())
            self.assertEqual(list(pathlib.Path(elsewhere).iterdir()), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
