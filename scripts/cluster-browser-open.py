#!/usr/bin/env python3
"""Request one browser navigation or Termux return; never verify a screen."""

import argparse
import base64
import hashlib
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
ANDROID_NATIVE_TIMEOUT_SECONDS = 15
# BEGIN PINNED ANDROID DEX (generated from scripts/android/CurtStartActivityWait.java)
ANDROID_NATIVE_SHA256 = '3fe09e4ae5563c15eaad3b9a4ce54607b79ce5d75b541ef3872db3aec0a9f37a'
ANDROID_NATIVE_DEX_B64 = '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AQAAAAEAAAACAAAAAQABAAEAAAARAAAAAQAAABQAAAACAAAAAgAjAAUAAAALABEAFAAnACgAAAACAAAAEQAoAAEAAAAoAAAAAQAAAB8AAAABAAAAAAAAAAEAAAACAAAAAQAAACYAAAABAAAAJwAAAAIAAAAUACcAAgAAABIAFAADAAAAHQARACgAAAABAAAAKQAAAAEAAAAKAAAAAgAAABQAAQATIiwid2FpdF90aW1lZF9vdXQiOgABKAADKClWAAEpAAMqPjsABCo+O1sACywiYWN0aW9uIjoiABwsImFjdGl2aXR5X3JlcXVlc3RfZW50ZXJlZCI6ADosImJpbmRlcl9jYWxsX3RpbWVkX291dCI6dHJ1ZSwid2FpdF9yZXN1bHRfcmVjZWl2ZWQiOmZhbHNlAHgsImNhbGxpbmdfcGFja2FnZSI6ImNvbS50ZXJtdXgiLCJwYWNrYWdlX2F0dHJpYnV0aW9uX3ZlcmlmaWVkIjp0cnVlLCJjYWxsZXJfdGhyZWFkX2lzX251bGwiOnRydWUsIm9wdGlvbnNfYXJlX251bGwiOnRydWUAEywiY2xhc3NpZmljYXRpb24iOiIAECwiZXJyb3JfY2xhc3MiOiIALywibWF4aW11bV9hY3Rpdml0eV9yZXF1ZXN0cyI6MSwibm9fcmV0cnkiOnRydWV9ABYsInJlcG9ydGVkX2NvbXBvbmVudCI6ABosInJlcG9ydGVkX3RvdGFsX3RpbWVfbXMiOgAHLCJzZGsiOgAHLCJ1aWQiOgAILCJ1cmwiOiIACywidXNlcl9pZCI6ADAsIndhaXRfcmVzdWx0X3JlY2VpdmVkIjp0cnVlLCJyYXdfc3RhcnRfcmVzdWx0IjoAAS4ABjxpbml0PgACPjsAD0FjdGlvbiByZXF1aXJlZAArQWN0aXZpdHkgdGFzayBtYW5hZ2VyIGludGVyZmFjZSB1bmF2YWlsYWJsZQABQwACQ0kAFEN1cnRTYW1lVWlkU3RhcnRXYWl0ABpDdXJ0U3RhcnRBY3Rpdml0eVdhaXQuamF2YQAOSG9zdG5hbWUgbGFiZWwAAUkAAklJAANJSUkAAklMAAFKAAJKTAABTAACTEMAGUxDdXJ0U3RhcnRBY3Rpdml0eVdhaXQkMTsAF0xDdXJ0U3RhcnRBY3Rpdml0eVdhaXQ7AAJMSQADTElJAAJMSgADTEpMAAJMTAADTExJAANMTEwABkxMTExMTAACTFoAI0xkYWx2aWsvYW5ub3RhdGlvbi9FbmNsb3NpbmdNZXRob2Q7AB5MZGFsdmlrL2Fubm90YXRpb24vSW5uZXJDbGFzczsAHUxkYWx2aWsvYW5ub3RhdGlvbi9TaWduYXR1cmU7ABpMZGFsdmlrL2Fubm90YXRpb24vVGhyb3dzOwAVTGphdmEvaW8vUHJpbnRTdHJlYW07ABhMamF2YS9sYW5nL0NoYXJTZXF1ZW5jZTsAEUxqYXZhL2xhbmcvQ2xhc3M7ABFMamF2YS9sYW5nL0NsYXNzPAAVTGphdmEvbGFuZy9FeGNlcHRpb247ACRMamF2YS9sYW5nL0lsbGVnYWxBcmd1bWVudEV4Y2VwdGlvbjsAIUxqYXZhL2xhbmcvSWxsZWdhbFN0YXRlRXhjZXB0aW9uOwATTGphdmEvbGFuZy9JbnRlZ2VyOwAQTGphdmEvbGFuZy9NYXRoOwASTGphdmEvbGFuZy9PYmplY3Q7ABRMamF2YS9sYW5nL1J1bm5hYmxlOwAdTGphdmEvbGFuZy9TZWN1cml0eUV4Y2VwdGlvbjsAEkxqYXZhL2xhbmcvU3RyaW5nOwAZTGphdmEvbGFuZy9TdHJpbmdCdWlsZGVyOwASTGphdmEvbGFuZy9TeXN0ZW07ABJMamF2YS9sYW5nL1RocmVhZDsAFUxqYXZhL2xhbmcvVGhyb3dhYmxlOwApTGphdmEvbGFuZy9VbnN1cHBvcnRlZE9wZXJhdGlvbkV4Y2VwdGlvbjsAH0xqYXZhL2xhbmcvcmVmbGVjdC9Db25zdHJ1Y3RvcjsAGUxqYXZhL2xhbmcvcmVmbGVjdC9GaWVsZDsALUxqYXZhL2xhbmcvcmVmbGVjdC9JbnZvY2F0aW9uVGFyZ2V0RXhjZXB0aW9uOwAaTGphdmEvbGFuZy9yZWZsZWN0L01ldGhvZDsADkxqYXZhL25ldC9VUkk7ABJMamF2YS91dGlsL0xvY2FsZTsAH0xqYXZhL3V0aWwvY29uY3VycmVudC9DYWxsYWJsZTsAH0xqYXZhL3V0aWwvY29uY3VycmVudC9DYWxsYWJsZTwAKUxqYXZhL3V0aWwvY29uY3VycmVudC9FeGVjdXRpb25FeGNlcHRpb247ACFMamF2YS91dGlsL2NvbmN1cnJlbnQvRnV0dXJlVGFzazsAH0xqYXZhL3V0aWwvY29uY3VycmVudC9UaW1lVW5pdDsAJ0xqYXZhL3V0aWwvY29uY3VycmVudC9UaW1lb3V0RXhjZXB0aW9uOwAVTm8gQW5kcm9pZCBXYWl0UmVzdWx0ACNPcmRpbmFyeSBpbnN0YWxsZWQgYXBwIFVJRCByZXF1aXJlZAAHUEFDS0FHRQAuUGFja2FnZSBtdXN0IGJlbG9uZyB0byB0aGUgYWN0dWFsIGludm9raW5nIFVJRAAZUHVibGljIEhUVFBTIFVSTCByZXF1aXJlZAAYUHVibGljIGhvc3RuYW1lIHJlcXVpcmVkAARST09UABFSZXNlcnZlZCBob3N0bmFtZQApUmV2aWV3ZWQgQW5kcm9pZCBBUEkzNSBzaWduYXR1cmUgcmVxdWlyZWQAB1NES19JTlQAB1NFQ09ORFMADVNUQVJUX0FCT1JURUQAFlNUQVJUX0RFTElWRVJFRF9UT19UT1AADVNUQVJUX1NVQ0NFU1MAE1NUQVJUX1RBU0tfVE9fRlJPTlQAJFNhbWUgVUlEIFRlcm11eCBhdHRyaWJ1dGlvbiByZXF1aXJlZAAEVFlQRQATVU5SRUNPR05JWkVEX1JFU1VMVAAOVVJMIGNoYXJhY3RlcnMAClVSTCBsZW5ndGgAGFVuc3VwcG9ydGVkIGZpeGVkIGFjdGlvbgABVgACVkkAAlZMAANWTEwABFZMTEwAAlZaAAxXQUlUX1NFQ09ORFMAAVoAAlpMAAFbAAZbMC05XSsAEltMamF2YS9sYW5nL0NsYXNzOwATW0xqYXZhL2xhbmcvT2JqZWN0OwATW0xqYXZhL2xhbmcvU3RyaW5nOwAkW2EtejAtOV0oPzpbYS16MC05LV17MCw2MX1bYS16MC05XSk/AAJcLgALYWNjZXNzRmxhZ3MAC2FkZENhdGVnb3J5AAhhZGRGbGFncwAfYW5kcm9pZC5hcHAuQWN0aXZpdHlUYXNrTWFuYWdlcgAaYW5kcm9pZC5hcHAuQWN0aXZpdHlUaHJlYWQAF2FuZHJvaWQuYXBwLkNvbnRleHRJbXBsACBhbmRyb2lkLmFwcC5JQWN0aXZpdHlUYXNrTWFuYWdlcgAeYW5kcm9pZC5hcHAuSUFwcGxpY2F0aW9uVGhyZWFkABVhbmRyb2lkLmFwcC5Mb2FkZWRBcGsAGGFuZHJvaWQuYXBwLlByb2ZpbGVySW5mbwAWYW5kcm9pZC5hcHAuV2FpdFJlc3VsdAAdYW5kcm9pZC5jb250ZW50LkNvbXBvbmVudE5hbWUAF2FuZHJvaWQuY29udGVudC5Db250ZXh0ABZhbmRyb2lkLmNvbnRlbnQuSW50ZW50ABphbmRyb2lkLmludGVudC5hY3Rpb24uTUFJTgAaYW5kcm9pZC5pbnRlbnQuYWN0aW9uLlZJRVcAIGFuZHJvaWQuaW50ZW50LmNhdGVnb3J5LkxBVU5DSEVSAA9hbmRyb2lkLm5ldC5VcmkAGGFuZHJvaWQub3MuQnVpbGQkVkVSU0lPTgARYW5kcm9pZC5vcy5CdW5kbGUAEmFuZHJvaWQub3MuSUJpbmRlcgARYW5kcm9pZC5vcy5Mb29wZXIAEmFuZHJvaWQub3MuUHJvY2VzcwAGYXBwZW5kAARjYWxsAAZjaGFyQXQADmNsYXNzaWZpY2F0aW9uAApjb20udGVybXV4AB1jb20udGVybXV4LmFwcC5UZXJtdXhBY3Rpdml0eQAIY29udGFpbnMAEGNyZWF0ZUFwcENvbnRleHQAFGNyZWF0ZVBhY2thZ2VDb250ZXh0AAhlbmRzV2l0aAAGZXF1YWxzABBlcXVhbHNJZ25vcmVDYXNlAAZlc2NhcGUABGV4aXQAFGZsYXR0ZW5Ub1Nob3J0U3RyaW5nAAdmb3JOYW1lAANnZXQAEmdldEFwcGxpY2F0aW9uSW5mbwAKZ2V0Qm9vbGVhbgAIZ2V0Q2F1c2UACGdldENsYXNzAA5nZXRDb25zdHJ1Y3RvcgAQZ2V0RGVjbGFyZWRGaWVsZAARZ2V0RGVjbGFyZWRNZXRob2QACGdldEZpZWxkAAdnZXRIb3N0AAZnZXRJbnQAB2dldExvbmcADWdldE1haW5Mb29wZXIACWdldE1ldGhvZAAHZ2V0TmFtZQAQZ2V0T3BQYWNrYWdlTmFtZQAOZ2V0UGFja2FnZU5hbWUAB2dldFBvcnQADmdldFJhd1VzZXJJbmZvAAlnZXRTY2hlbWUACmdldFNlcnZpY2UAEGdldFN5c3RlbUNvbnRleHQABWh0dHBzAAdpbmRleE9mAAhpbnRWYWx1ZQAGaW52b2tlAAppc0luc3RhbmNlAAZsZW5ndGgADG1QYWNrYWdlSW5mbwAEbWFpbgAHbWF0Y2hlcwADbWluAAVteVVpZAAEbmFtZQALbmV3SW5zdGFuY2UABG51bGwADG9wZW4td2Vic2l0ZQADb3V0AAVwYXJzZQARcHJlcGFyZU1haW5Mb29wZXIAB3ByaW50bG4ABnJlc3VsdAANcmV0dXJuLXRlcm11eAANc2V0QWNjZXNzaWJsZQAMc2V0Q2xhc3NOYW1lAAlzZXREYWVtb24AB3NldERhdGEABXNwbGl0AAVzdGFydAAUc3RhcnRBY3Rpdml0eUFuZFdhaXQACXN1YnN0cmluZwAKc3lzdGVtTWFpbgAHdGltZW91dAALdG9Mb3dlckNhc2UACHRvU3RyaW5nAAl0b3RhbFRpbWUAA3VpZAARdmFsJGNhbGxBcmd1bWVudHMAC3ZhbCRzZXJ2aWNlAAl2YWwkc3RhcnQADHZhbGlkYXRlZFVybAAFdmFsdWUAB3ZhbHVlT2YAA3dobwCUAXsia2luZCI6ImNsdXN0ZXItYW5kcm9pZC1zdGFydC1yZXN1bHQiLCJwZXJtaXNzaW9uc19jaGFuZ2VkIjpmYWxzZSwic2V0dGluZ3NfY2hhbmdlZCI6ZmFsc2UsImlkZW50aXR5X2NoYW5nZWQiOmZhbHNlLCJ2aXNpYmxlX3NjcmVlbl92ZXJpZmllZCI6ZmFsc2UAAXwASnxsb2NhbGhvc3R8bG9jYWx8bG9jYWxkb21haW58aG9tZXxsYW58aW50ZXJuYWx8dGVzdHxpbnZhbGlkfG9uaW9ufGV4YW1wbGV8AGZ+fkQ4eyJiYWNrZW5kIjoiZGV4IiwiY29tcGlsYXRpb24tbW9kZSI6ImRlYnVnIiwiaGFzLWNoZWNrc3VtcyI6ZmFsc2UsIm1pbi1hcGkiOjM1LCJ2ZXJzaW9uIjoiOC4zLjM3In0AAgcB3AEcARcCAggB3AEcARgMAgUB3AEaBgIGAngEAMABHgIHAdwBHAQXPhdOFz4XFgIHAdwBHAsXARc4FwQXPhdBF3EXOBcFFz4XAxc+AAMBAQCQIAGQIAGQIACAgATIEgEBoBICAAYAAxoBGgKBgATcGAEKkBMBCtgTAYoB7BIBCfQYAQrcFAIXkwQKAAEAAACCKQAAAQAAAIspAAADAAAAlCkAAJspAACkKQAAAgAAALMpAACLKQAAICoAAAAAAAACAAAAAAAAAAAAAAAQKgAAAQAAABgqAAAAAAAAAAAAAAIAAAAAAAAABQAAADAqAAAHAAAAGCoAABEAAAAAAAAAAQAAAAAAAAABAAAA4wAAAHAAAAACAAAAKgAAAPwDAAADAAAAKQAAAKQEAAAEAAAACQAAAJAGAAAFAAAAQQAAANgGAAAGAAAAAgAAAOAIAAABIAAACAAAACAJAAADIAAACAAAAGwXAAABEAAAFAAAAJQYAAACIAAA4wAAAEAZAAAEIAAABgAAAIIpAAAAIAAAAgAAANApAAAFIAAAAQAAAAoqAAADEAAABAAAABAqAAAGIAAAAgAAADwqAAAAEAAAAQAAAHwqAAA='
# END PINNED ANDROID DEX
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
            if len(host) > 253 or len(labels) < 2 or labels[-1].isdigit() or any(
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


def android_native_cache(environ, uid):
    """Stage only pinned public code in an owned private cache; never an APK."""
    home = pathlib.Path(environ.get("HOME", ""))
    if not home.is_absolute():
        raise LaunchError("An existing owned Termux home directory is required.")
    info = home.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
        raise LaunchError("Termux home metadata could not be verified.")
    data = base64.b64decode(ANDROID_NATIVE_DEX_B64, validate=True)
    if not 0 < len(data) <= 65536 or hashlib.sha256(data).hexdigest() != ANDROID_NATIVE_SHA256:
        raise LaunchError("Pinned Android launcher code did not verify.")
    descriptor = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    cache = home
    try:
        if (os.fstat(descriptor).st_dev, os.fstat(descriptor).st_ino) != (info.st_dev, info.st_ino):
            raise LaunchError("Termux home changed before code staging.")
        for name in ("cluster", "control", "browser-start-" + ANDROID_NATIVE_SHA256[:16]):
            try:
                os.mkdir(name, mode=0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            final = name.startswith("browser-start-")
            if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid
                    or info.st_mode & 0o022 or final and stat.S_IMODE(info.st_mode) != 0o700):
                raise LaunchError("Owned Android code cache metadata did not verify.")
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=descriptor)
            try:
                if (os.fstat(child).st_dev, os.fstat(child).st_ino) != (info.st_dev, info.st_ino):
                    raise LaunchError("Android code cache changed before staging.")
            except BaseException:
                os.close(child)
                raise
            os.close(descriptor)
            descriptor = child
            cache /= name
        filename = "launcher.dex"
        try:
            output = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o400, dir_fd=descriptor)
        except FileExistsError:
            pass
        else:
            with os.fdopen(output, "wb") as stream:
                stream.write(data)
        info = os.stat(filename, dir_fd=descriptor, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o400
                or info.st_nlink != 1 or info.st_size != len(data)):
            raise LaunchError("Pinned Android code file metadata did not verify.")
        source = os.open(filename, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=descriptor)
        with os.fdopen(source, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_size) != (info.st_dev, info.st_ino, info.st_size):
                raise LaunchError("Pinned Android code file changed before verification.")
            if hashlib.sha256(stream.read(len(data) + 1)).hexdigest() != ANDROID_NATIVE_SHA256:
                raise LaunchError("Pinned Android code digest did not verify.")
        return str(cache / filename)
    finally:
        os.close(descriptor)


def android_request(report, action, environ, run, uid=None, native_prepare=None):
    """One native request, no legacy am fallback; platform acceptance is not visibility."""
    prefix = environ.get("PREFIX", "")
    if not (prefix.startswith("/data/") and prefix.endswith("/com.termux/files/usr")):
        raise LaunchError("The existing ordinary Termux app environment is required.")
    uid = getattr(os, "getuid", lambda: -1)() if uid is None else uid
    if not isinstance(uid, int) or isinstance(uid, bool) or uid < 10000 or not 10000 <= uid % 100000 < 99000:
        raise LaunchError("An existing ordinary Termux app UID is required.")
    prepare = android_native_cache if native_prepare is None else native_prepare
    path = prepare(environ, uid)
    command_env = dict(environ)
    command_env.pop("LD_PRELOAD", None)
    command_env.pop("LD_LIBRARY_PATH", None)
    command_env["CLASSPATH"] = path
    command = ["/system/bin/app_process", "/", "CurtStartActivityWait", action]
    if action == "open-website":
        command.append(report["url"])
    report["launcher"] = command[0]
    completed = run(command, env=command_env, stdin=subprocess.DEVNULL,
                    capture_output=True, text=True, timeout=ANDROID_NATIVE_TIMEOUT_SECONDS,
                    check=False, shell=False)
    report["opener_completed" if action == "open-website" else "request_completed"] = True
    if not isinstance(completed.stdout, str) or len(completed.stdout) > 16384:
        raise LaunchError("Android returned an invalid launch receipt; the request is unconfirmed and will not be retried.")
    try:
        native = json.loads(completed.stdout)
    except (ValueError, TypeError):
        raise LaunchError("Android returned no valid launch receipt; the request is unconfirmed and will not be retried.")
    if not isinstance(native, dict):
        raise LaunchError("Android returned an invalid launch receipt; the request is unconfirmed and will not be retried.")
    fields = ("action", "uid", "user_id", "sdk", "calling_package", "package_attribution_verified",
              "wait_result_received", "raw_start_result", "classification", "wait_timed_out",
              "reported_component", "reported_total_time_ms", "binder_call_timed_out",
              "activity_request_entered", "maximum_activity_requests", "no_retry", "error_class")
    # Do not duplicate the potentially2048-character URL in the bounded worker receipt.
    report["android_start"] = {key: native[key] for key in fields if key in native}
    valid = (native.get("kind") == "cluster-android-start-result" and native.get("action") == action
             and type(native.get("uid")) is int and native["uid"] == uid
             and type(native.get("user_id")) is int and native["user_id"] == uid // 100000
             and type(native.get("sdk")) is int and native["sdk"] == 35
             and native.get("calling_package") == "com.termux" and native.get("package_attribution_verified") is True
             and native.get("caller_thread_is_null") is True and native.get("options_are_null") is True
             and type(native.get("maximum_activity_requests")) is int
             and native["maximum_activity_requests"] == 1 and native.get("no_retry") is True
             and native.get("permissions_changed") is False and native.get("settings_changed") is False
             and native.get("identity_changed") is False and native.get("visible_screen_verified") is False
             and native.get("activity_request_entered") is True
             and (native.get("url") == report["url"] if action == "open-website" else "url" not in native))
    raw = native.get("raw_start_result")
    if valid and type(raw) is int and raw == 102:
        report["error_code"] = "android-background-launch-blocked"
        report["error"] = "Android blocked this background activity launch (START_ABORTED102). No retry was sent."
        return report
    component = native.get("reported_component")
    accepted = {0: "START_SUCCESS", 2: "START_TASK_TO_FRONT", 3: "START_DELIVERED_TO_TOP"}
    if (not valid or completed.returncode != 0 or type(raw) is not int or raw not in accepted
            or native.get("classification") != accepted[raw] or native.get("wait_result_received") is not True
            or native.get("wait_timed_out") is not False or native.get("binder_call_timed_out")
            or native.get("error_class") or not isinstance(component, str)
            or not re.fullmatch(r"[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+", component) or len(component) > 180
            or action == "return-termux" and component not in {"com.termux/.app.TermuxActivity", "com.termux/com.termux.app.TermuxActivity"}):
        raise LaunchError("Android did not return a verified activity-launch receipt; outcome is unconfirmed and will not be retried.")
    report["state"] = "launch-requested" if action == "open-website" else "return-requested"
    report["launch_requested" if action == "open-website" else "return_requested"] = True
    return report


def open_browser(url, environ=None, current_platform=None, run=None, which=None, uid=None,
                 proc_reader=None, session_checker=None, popen=None, native_prepare=None):
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
            return android_request(report, "open-website", environ, run, uid, native_prepare)
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
    except subprocess.TimeoutExpired:
        report["error"] = "Android launch receipt timed out; outcome is unconfirmed. No retry was sent."
    except (LaunchError, OSError, ValueError) as exc:
        report["error"] = compact_text(exc) or type(exc).__name__
    if platform == "android":
        report.setdefault("error_code", "android-launch-unconfirmed")
    return report


def return_termux(environ=None, current_platform=None, run=None, which=None, uid=None, native_prepare=None):
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
        return android_request(report, "return-termux", environ, run, uid, native_prepare)
    except subprocess.TimeoutExpired:
        report["error"] = "Android return receipt timed out; outcome is unconfirmed. No retry was sent."
    except (LaunchError, OSError, ValueError) as exc:
        report["error"] = compact_text(exc) or type(exc).__name__
    if platform == "android":
        report.setdefault("error_code", "android-launch-unconfirmed")
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
