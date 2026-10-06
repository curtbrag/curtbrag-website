#!/usr/bin/env python3
"""One bounded HTTPS HTML request; this is not a browser or viewer session."""

import argparse
import base64
import http.client
import ipaddress
import json
import queue
import re
import socket
import ssl
import threading
import time
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit, urlunsplit


KIND = "website-load-test"
SCOPE = "Single HTTP HTML check; no browser, assets, playback, login, or viewer session."
MAX_BYTES = 524288
TIMEOUT = 12.0
MAX_URL_LENGTH = 512


class SafetyError(ValueError):
    pass


def bounded_text(value, max_chars, max_json_chars):
    """Budget escaped JSON too, since Windows workers cap stdout at 4,000."""
    text = str(value)[:max_chars]
    while len(json.dumps(text, ensure_ascii=True)) - 2 > max_json_chars:
        text = text[:-1]
    return text


def normalize_host(host):
    if not isinstance(host, str) or not host or host.endswith("."):
        raise SafetyError("A valid public hostname is required.")
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    try:
        host = host.encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise SafetyError("Invalid hostname.") from exc
    labels = host.split(".")
    if len(host) > 253 or len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in labels
    ):
        raise SafetyError("A valid public hostname is required.")
    if labels[-1] in {"localhost", "local", "lan", "internal", "test", "invalid", "onion"}:
        raise SafetyError("Local and reserved hostnames are excluded.")
    return host


def validate_url(url, allowed_hosts=None):
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise SafetyError("Use one HTTPS URL of at most 512 characters.")
    if any(ord(char) <= 32 or ord(char) == 127 for char in url) or "\\" in url:
        raise SafetyError("URL contains unsafe whitespace or characters.")
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() != "https" or not parsed.netloc:
            raise SafetyError("Only public HTTPS pages are supported.")
        if parsed.username is not None or parsed.password is not None or "#" in url or "?" in url:
            raise SafetyError("Credentials, queries, and fragments are excluded.")
        if parsed.port not in (None, 443):
            raise SafetyError("Only the default HTTPS port is supported.")
        host = normalize_host(parsed.hostname)
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise SafetyError("Use an approved public hostname, not an IP address.")
    except ValueError as exc:
        if isinstance(exc, SafetyError):
            raise
        raise SafetyError("Invalid HTTPS URL.") from exc
    if allowed_hosts is not None and host not in allowed_hosts:
        raise SafetyError("The page or redirect is outside the approved hostnames.")
    authority = "[" + host + "]" if ":" in host else host
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parsed.query, safe="/%?:@!$&'()*+,;=-._~")
    normalized = urlunsplit(("https", authority, path, query, ""))
    if len(normalized) > MAX_URL_LENGTH:
        raise SafetyError("Encoded URL is too long.")
    return normalized, host, path + ("?" + query if query else "")


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError("The page check exceeded its time limit.")
    return seconds


def resolve_public(host, deadline):
    """Resolve once with a bounded wait and reject mixed public/private answers."""
    result = queue.Queue(maxsize=1)

    def resolve():
        try:
            result.put((True, socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
        except Exception as exc:
            result.put((False, exc))

    threading.Thread(target=resolve, daemon=True).start()
    try:
        ok, values = result.get(timeout=remaining(deadline))
    except queue.Empty as exc:
        raise TimeoutError("Hostname lookup exceeded the time limit.") from exc
    if not ok:
        raise OSError("Hostname could not be resolved.") from values
    addresses = []
    for family, socktype, protocol, _name, address in values:
        if family not in (socket.AF_INET, socket.AF_INET6):
            raise SafetyError("Unsupported address type.")
        try:
            ip = ipaddress.ip_address(address[0])
        except ValueError as exc:
            raise SafetyError("Invalid resolved address.") from exc
        # IPv4-mapped IPv6 must be vetted as IPv4 as well.
        checked = ip.ipv4_mapped if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped else ip
        if not checked.is_global or checked.is_multicast or checked.is_unspecified:
            raise SafetyError("Private, local, and reserved network addresses are excluded.")
        entry = (family, socktype, protocol, address)
        if entry not in addresses:
            addresses.append(entry)
    if not addresses:
        raise OSError("Hostname returned no public addresses.")
    remaining(deadline)
    return addresses


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Keep hostname TLS verification while connecting only to vetted addresses."""

    def __init__(self, host, addresses, deadline):
        super().__init__(host, port=443, timeout=remaining(deadline), context=ssl.create_default_context())
        self.addresses = addresses
        self.deadline = deadline

    def connect(self):
        last_error = None
        for family, socktype, protocol, address in self.addresses:
            candidate = socket.socket(family, socktype, protocol)
            try:
                candidate.settimeout(remaining(self.deadline))
                candidate.connect(address)
                candidate.settimeout(remaining(self.deadline))
                self.sock = self._context.wrap_socket(candidate, server_hostname=self.host)
                self.sock.settimeout(remaining(self.deadline))
                return
            except (OSError, TimeoutError) as exc:
                last_error = exc
                candidate.close()
        raise OSError("Could not establish a verified HTTPS connection.") from last_error


class TitleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.finished = False
        self.parts = []
        self.size = 0

    def handle_starttag(self, tag, attrs):
        if tag == "title" and not self.finished:
            self.in_title = True

    def handle_endtag(self, tag):
        if tag == "title" and self.in_title:
            self.in_title = False
            self.finished = True

    def handle_data(self, value):
        if self.in_title and self.size < 1000:
            part = value[:1000 - self.size]
            self.parts.append(part)
            self.size += len(part)

    @property
    def title(self):
        return bounded_text(" ".join("".join(self.parts).split()), 300, 1600)


def read_title(body, content_type):
    match = re.search(r"charset\s*=\s*[\"']?([\w.-]+)", content_type, re.I)
    charset = match.group(1) if match else "utf-8"
    try:
        text = body.decode(charset, errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    parser = TitleParser()
    parser.feed(text)
    return parser.title


def test_website(url, allowed_hosts=None, timeout=TIMEOUT, max_bytes=MAX_BYTES):
    """Return one compact report. No state, retry, cookie, proxy, or browser APIs."""
    started = time.monotonic()
    deadline = started + min(max(float(timeout), 0.01), TIMEOUT)
    max_bytes = min(max(int(max_bytes), 1), MAX_BYTES)
    report = {
        "kind": KIND,
        "ok": False,
        "url": bounded_text(url, MAX_URL_LENGTH, MAX_URL_LENGTH),
        "final_url": None,
        "status": None,
        "title": "",
        "total_ms": 0,
        "bytes": 0,
        "content_type": "",
        "truncated": False,
        "redirects": 0,
        "scope": SCOPE,
        "error": None,
    }
    connection = None
    response = None
    deadline_timer = None
    try:
        normalized, host, target = validate_url(url)
        approved = {normalize_host(value) for value in allowed_hosts} if allowed_hosts is not None else {host}
        normalized, host, target = validate_url(normalized, approved)
        report["url"] = normalized
        current = normalized
        seen = set()
        while True:
            if current in seen:
                raise SafetyError("Redirect loop detected.")
            seen.add(current)
            current, host, target = validate_url(current, approved)
            addresses = resolve_public(host, deadline)
            connection = PinnedHTTPSConnection(host, addresses, deadline)
            connection.request("GET", target, headers={
                "User-Agent": "CurtClusterWebsiteTest/1.0 (single HTML check)",
                "Accept": "text/html, application/xhtml+xml",
                "Accept-Encoding": "identity",
                "Connection": "close",
            })
            live_socket = connection.sock
            live_socket.settimeout(remaining(deadline))

            # A socket timeout alone resets for each receive. A slow header or
            # chunk-size line could otherwise trickle forever inside readline.
            def abort_slow_response(transport=live_socket):
                try:
                    transport.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

            deadline_timer = threading.Timer(remaining(deadline), abort_slow_response)
            deadline_timer.daemon = True
            deadline_timer.start()
            response = connection.getresponse()
            remaining(deadline)
            report["status"] = response.status
            report["final_url"] = current
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                if not location:
                    raise SafetyError("Redirect did not include a destination.")
                if report["redirects"] >= 3:
                    raise SafetyError("Redirect limit reached.")
                # Validate before any lookup or request for the new destination.
                current, _, _ = validate_url(urljoin(current, location), approved)
                report["redirects"] += 1
                response.close()
                connection.close()
                deadline_timer.cancel()
                deadline_timer = None
                connection = None
                continue
            report["content_type"] = bounded_text(response.getheader("Content-Type") or "", 200, 200)
            if not 200 <= response.status < 300:
                raise OSError("Page returned HTTP " + str(response.status) + ".")
            media_type = report["content_type"].split(";", 1)[0].strip().lower()
            if media_type not in {"text/html", "application/xhtml+xml"}:
                raise SafetyError("The response is not an HTML page.")
            if (response.getheader("Content-Encoding") or "identity").strip().lower() not in {"", "identity"}:
                raise SafetyError("Compressed responses are excluded from this bounded check.")
            body = bytearray()
            while len(body) < max_bytes:
                live_socket.settimeout(remaining(deadline))
                chunk = response.read1(min(16384, max_bytes - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
                report["bytes"] = len(body)
            remaining(deadline)
            # A cap hit is conservatively marked truncated; no extra body byte is read.
            report["truncated"] = len(body) == max_bytes
            report["title"] = read_title(bytes(body), report["content_type"])
            remaining(deadline)
            report["ok"] = True
            break
    except (SafetyError, OSError, TimeoutError, http.client.HTTPException, ValueError) as exc:
        report["error"] = bounded_text(exc, 300, 300) or type(exc).__name__
    finally:
        if deadline_timer is not None:
            deadline_timer.cancel()
        if response is not None:
            response.close()
        if connection is not None:
            connection.close()
        report["total_ms"] = round((time.monotonic() - started) * 1000, 1)
    return report


def main():
    parser = argparse.ArgumentParser(description=SCOPE)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url")
    source.add_argument("--settings-b64", help='Base64 UTF-8 JSON containing only {"url":"https://owned.example/"}.')
    parser.add_argument("--allowed-host", action="append", help="Approved owned hostname; repeat for explicit redirect hosts. Defaults to the input hostname only.")
    args = parser.parse_args()
    url = args.url
    if args.settings_b64 is not None:
        try:
            if len(args.settings_b64) > 4096:
                raise ValueError("Settings are too large.")
            settings = json.loads(base64.b64decode(args.settings_b64, validate=True).decode("utf-8"))
            if not isinstance(settings, dict) or set(settings) != {"url"} or not isinstance(settings["url"], str):
                raise ValueError("Settings must contain only a URL string.")
            url = settings["url"]
        except (ValueError, UnicodeError) as exc:
            report = test_website("")
            report["error"] = "Invalid encoded URL settings."
            print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))
            return 1
    report = test_website(url, args.allowed_host)
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

