#!/usr/bin/env python3
"""Request one browser navigation or Termux return; never verify a screen."""

import argparse
import base64
import ipaddress
import json
import os
import pathlib
import posixpath
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import quote, urlsplit, urlunsplit


TIMEOUT_SECONDS = 20
DESKTOP_OBSERVATION_SECONDS = 3
MAX_URL_LENGTH = 2048
DESKTOP_KEYS = frozenset({
    "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
    "XAUTHORITY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION",
})
DESKTOP_PROCESSES = frozenset({
    "gnome-shell", "gnome-session", "gnome-session-binary", "plasmashell", "ksmserver",
    "kwin_wayland", "kwin_x11", "sway", "weston", "Hyprland", "Xwayland",
    "cinnamon", "xfce4-session", "lxqt-session", "mate-session", "gamescope", "steam",
})


class LaunchError(ValueError):
    pass


def compact_text(value, limit=500):
    text = " ".join(str(value).split())[:limit]
    while len(json.dumps(text, ensure_ascii=True)) - 2 > limit:
        text = text[:-1]
    return text


def validate_url(url):
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise LaunchError("Use one HTTPS URL of at most 2048 characters.")
    if any(ord(char) <= 32 or ord(char) == 127 for char in url) or "\\" in url:
        raise LaunchError("URL contains unsafe whitespace or characters.")
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() != "https" or not parsed.netloc:
            raise LaunchError("Only HTTPS browser navigation is supported.")
        if parsed.username is not None or parsed.password is not None:
            raise LaunchError("Credentials in URLs are excluded.")
        if parsed.port not in (None, 443):
            raise LaunchError("Only the default HTTPS port is supported.")
        host = parsed.hostname
        if not host or host.endswith("."):
            raise LaunchError("A valid public hostname is required.")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            host = host.encode("idna").decode("ascii").lower()
            labels = host.split(".")
            if len(host) > 253 or len(labels) < 2 or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in labels
            ):
                raise LaunchError("A valid public hostname is required.")
            if labels[-1] in {"localhost", "local", "localdomain", "home", "lan", "internal", "test", "invalid", "onion", "example"}:
                raise LaunchError("Local and reserved hostnames are excluded.")
        else:
            raise LaunchError("Use a public hostname; IP addresses are excluded.")
    except (ValueError, UnicodeError) as exc:
        if isinstance(exc, LaunchError):
            raise
        raise LaunchError("Invalid HTTPS URL.") from exc
    authority = "[" + host + "]" if ":" in host else host
    normalized = urlunsplit(("https", authority,
                            quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~"), "", ""))
    if "?" in url.split("#", 1)[0]:
        normalized += "?" + quote(parsed.query, safe="/%?:@!$&'()*+,;=-._~")
    if "#" in url:
        normalized += "#" + quote(parsed.fragment, safe="/%?:@!$&'()*+,;=-._~#")
    if len(normalized) > MAX_URL_LENGTH:
        raise LaunchError("Encoded URL exceeds 2048 characters.")
    return normalized


def platform_name(environ, current_platform=None):
    prefix = environ.get("PREFIX", "")
    if environ.get("TERMUX_VERSION") or (prefix.startswith("/data/") and prefix.endswith("/com.termux/files/usr")):
        return "android"
    current_platform = sys.platform if current_platform is None else current_platform
    return "linux" if current_platform.startswith("linux") else current_platform


def desktop_values(environ):
    return {
        key: value for key, value in environ.items()
        if key in DESKTOP_KEYS and isinstance(value, str) and 0 < len(value) <= 1024
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    }


def own_desktop_environments(uid, proc_root="/proc"):
    """Read only selected environment keys from this UID's desktop processes."""
    root = pathlib.Path(proc_root)
    try:
        entries = sorted((entry for entry in root.iterdir() if entry.name.isdigit()), key=lambda entry: int(entry.name))[:2048]
    except OSError:
        return
    for entry in entries:
        try:
            if entry.stat().st_uid != uid:
                continue
            with (entry / "comm").open("rb") as stream:
                name = stream.read(64).decode("ascii", errors="replace").strip()
            if name not in DESKTOP_PROCESSES:
                continue
            with (entry / "environ").open("rb") as stream:
                raw = stream.read(65536)
            selected = {}
            for item in raw.split(b"\0"):
                key, separator, value = item.partition(b"=")
                if separator and key.decode("ascii", errors="replace") in DESKTOP_KEYS:
                    selected[key.decode("ascii")] = value.decode("utf-8", errors="replace")
            yield desktop_values(selected)
        except (OSError, UnicodeError):
            continue


def valid_graphical_environment(values, uid):
    runtime = values.get("XDG_RUNTIME_DIR")
    runtime_valid = False
    if runtime and posixpath.isabs(runtime):
        try:
            info = os.stat(runtime)
            runtime_valid = stat.S_ISDIR(info.st_mode) and info.st_uid == uid
        except OSError:
            pass
    wayland = values.get("WAYLAND_DISPLAY")
    if runtime_valid and wayland and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", wayland) and wayland not in {".", ".."}:
        try:
            info = os.stat(posixpath.join(runtime, wayland))
            if stat.S_ISSOCK(info.st_mode) and info.st_uid == uid:
                return True
        except OSError:
            pass
    display = values.get("DISPLAY", "")
    match = re.fullmatch(r":(\d{1,4})(?:\.\d{1,2})?", display)
    if match:
        try:
            if stat.S_ISSOCK(os.stat("/tmp/.X11-unix/X" + match.group(1)).st_mode):
                return True
        except OSError:
            pass
    return False


def find_graphical_environment(environ, uid, proc_reader=None, checker=None):
    checker = valid_graphical_environment if checker is None else checker
    current = desktop_values(environ)
    if checker(current, uid):
        return current
    reader = own_desktop_environments if proc_reader is None else proc_reader
    for values in reader(uid):
        values = desktop_values(values)
        if checker(values, uid):
            return values
    raise LaunchError("No verified graphical desktop session for this user. Browser launch is unavailable.")


def termux_launcher(environ, which):
    prefix = environ.get("PREFIX", "")
    if not (prefix.startswith("/data/") and prefix.endswith("/com.termux/files/usr")):
        raise LaunchError("Termux's existing am wrapper is required.")
    launcher = which("am", path=environ.get("PATH"))
    expected = prefix.rstrip("/") + "/bin/am"
    if not launcher or os.path.normpath(launcher) != os.path.normpath(expected):
        raise LaunchError("Termux's existing am wrapper is unavailable; system am is not used.")
    return launcher


def android_command(url, environ, which):
    launcher = termux_launcher(environ, which)
    # Foreground Termux can launch without overlay permission. Let Android
    # decide whether this activity start is allowed; exit zero is only a request.
    return launcher, [launcher, "start", "--user", "0", "-a", "android.intent.action.VIEW",
                      "-f", "0x18000000", "-d", url]


def open_browser(url, environ=None, current_platform=None, run=None, which=None, uid=None,
                 proc_reader=None, session_checker=None, popen=None):
    environ = dict(os.environ if environ is None else environ)
    run = subprocess.run if run is None else run
    popen = subprocess.Popen if popen is None else popen
    which = shutil.which if which is None else which
    platform = platform_name(environ, current_platform)
    report = {
        "kind": "website-browser-open", "url": compact_text(url, MAX_URL_LENGTH),
        "platform": platform, "state": "failed", "launch_requested": False,
        "visible_screen_verified": False, "launcher": None,
        "opener_completed": False,
        "scope": "Existing browser navigation request only; page rendering and physical screen are unverified.",
        "error": None,
    }
    try:
        report["url"] = validate_url(url)
        command_env = dict(environ)
        if platform == "android":
            launcher, command = android_command(report["url"], environ, which)
        elif platform == "linux":
            uid = os.getuid() if uid is None else uid
            desktop = find_graphical_environment(environ, uid, proc_reader, session_checker)
            # Remove stale SSH display variables before adding the actual session.
            for key in DESKTOP_KEYS:
                command_env.pop(key, None)
            command_env.update(desktop)
            launcher = which("gio", path=environ.get("PATH"))
            if launcher:
                command = [launcher, "open", report["url"]]
            else:
                launcher = which("xdg-open", path=environ.get("PATH"))
                if not launcher:
                    raise LaunchError("No existing xdg-open or gio browser opener is available.")
                command = [launcher, report["url"]]
        else:
            raise LaunchError("This helper supports Android Termux and Linux desktop sessions only.")
        report["launcher"] = launcher
        if platform == "linux":
            # Openers may become or spawn a long-lived browser. Captured pipes
            # can keep communicate() hanging after an opener timeout. Detach
            # all streams and observe briefly, leaving every browser intact.
            process = popen(command, env=command_env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            shell=False, start_new_session=True, close_fds=True)
            try:
                code = process.wait(timeout=DESKTOP_OBSERVATION_SECONDS)
            except subprocess.TimeoutExpired:
                code = None
            if code is not None and code != 0:
                raise LaunchError("Browser opener failed (exit " + str(code) + ").")
            report["opener_completed"] = code == 0
            report["state"] = "launch-requested"
            report["launch_requested"] = True
            return report
        completed = run(command, env=command_env, capture_output=True, text=True,
                        timeout=TIMEOUT_SECONDS, check=False, shell=False)
        report["opener_completed"] = True
        output = str(completed.stdout or "") + "\n" + str(completed.stderr or "")
        if 'requires the "Display over other apps" permission' in output:
            raise LaunchError("Termux's overlay permission precheck refused the request before Android attempted navigation. "
                              "This does not establish whether a foreground browser launch is allowed.")
        if completed.returncode != 0:
            raise LaunchError("Browser opener failed (exit " + str(completed.returncode) + "): " + compact_text(output))
        if platform == "android" and re.search(
            r"(?im)^\s*error(?:\s|:|$)|exception|permission denial|no activity found|unable to resolve intent|background activity start[^\n]*(?:denied|blocked|not allowed)",
            output,
        ):
            raise LaunchError("Android did not accept the browser request: " + compact_text(output))
        report["state"] = "launch-requested"
        report["launch_requested"] = True
    except subprocess.TimeoutExpired:
        report["error"] = "Browser opener did not return within 20 seconds; a visible launch is unconfirmed."
    except (LaunchError, OSError, ValueError) as exc:
        report["error"] = compact_text(exc) or type(exc).__name__
    return report


def return_termux(environ=None, current_platform=None, run=None, which=None):
    """Request the fixed existing Termux activity once, without closing a browser."""
    environ = dict(os.environ if environ is None else environ)
    run = subprocess.run if run is None else run
    which = shutil.which if which is None else which
    platform = platform_name(environ, current_platform)
    report = {
        "kind": "phone-termux-return", "platform": platform, "state": "failed",
        "return_requested": False, "request_completed": False,
        "visible_screen_verified": False, "launcher": None,
        "scope": "Existing Termux activity request only; foreground app and physical screen are unverified. Browser is not closed.",
        "error": None,
    }
    try:
        if platform != "android":
            raise LaunchError("Return to Termux is available only on Android Termux phones; desktop browsers are not changed.")
        launcher = termux_launcher(environ, which)
        report["launcher"] = launcher
        # This is a request to the existing app, not evidence that Android
        # brought it forward. Do not request grants or close another activity.
        command = [launcher, "start", "--user", "0", "-a", "android.intent.action.MAIN",
                   "-c", "android.intent.category.LAUNCHER", "-n", "com.termux/com.termux.app.TermuxActivity",
                   "-f", "0x10000000"]
        completed = run(command, env=environ, capture_output=True, text=True,
                        timeout=TIMEOUT_SECONDS, check=False, shell=False)
        report["request_completed"] = True
        output = str(completed.stdout or "") + "\n" + str(completed.stderr or "")
        if 'requires the "Display over other apps" permission' in output:
            raise LaunchError("Termux's overlay permission precheck refused the request before Android attempted the return. "
                              "A foreground return is unconfirmed.")
        if completed.returncode != 0:
            raise LaunchError("Termux return request failed (exit " + str(completed.returncode) + "): " + compact_text(output))
        if re.search(
            r"(?im)^\s*error(?:\s|:|$)|exception|permission denial|no activity found|unable to resolve intent|background activity start[^\n]*(?:denied|blocked|not allowed)",
            output,
        ):
            raise LaunchError("Android did not accept the Termux return request: " + compact_text(output))
        report["state"] = "return-requested"
        report["return_requested"] = True
    except subprocess.TimeoutExpired:
        report["error"] = "Termux return request did not return within 20 seconds; a foreground return is unconfirmed."
    except (LaunchError, OSError, ValueError) as exc:
        report["error"] = compact_text(exc) or type(exc).__name__
    return report


def main():
    parser = argparse.ArgumentParser(description="Request one browser navigation or Termux return; no screen verification.")
    parser.add_argument("--settings-b64", required=True)
    args = parser.parse_args()
    try:
        if len(args.settings_b64) > 16384:
            raise ValueError("Settings are too large")
        settings = json.loads(base64.b64decode(args.settings_b64, validate=True).decode("utf-8"))
        if isinstance(settings, dict) and set(settings) == {"url"} and isinstance(settings["url"], str):
            report = open_browser(settings["url"])
        elif isinstance(settings, dict) and set(settings) == {"action"} and settings["action"] == "return-termux":
            report = return_termux()
        else:
            raise ValueError("Settings must contain only a URL string or the fixed return-termux action")
    except (ValueError, UnicodeError):
        report = open_browser("")
        report["error"] = "Invalid encoded URL settings."
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))
    return 0 if report.get("launch_requested") or report.get("return_requested") else 1


if __name__ == "__main__":
    raise SystemExit(main())
