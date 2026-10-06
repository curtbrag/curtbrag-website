"""Safety and reporting tests: no live requests are made by this test suite."""

import base64
import importlib.util
import io
import json
import pathlib
import socket
import threading
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("cluster_url_test", pathlib.Path(__file__).with_name("cluster-url-test.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
PUBLIC = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, ("93.184.216.34", 443))]


class FakeResponse:
    def __init__(self, status=200, body=b"<title>Owned &amp; tested</title>", headers=None, error=None):
        self.status = status
        self.body = body
        self.headers = headers if headers is not None else {"Content-Type": "text/html; charset=utf-8"}
        self.offset = 0
        self.read_sizes = []
        self.error = error
        self.closed = False

    def getheader(self, key):
        return self.headers.get(key)

    def read1(self, size):
        self.read_sizes.append(size)
        if self.error:
            raise self.error
        chunk = self.body[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self, response):
        self.response = response
        self.sock = Mock()
        self.requests = []
        self.closed = False

    def request(self, method, target, headers):
        self.requests.append((method, target, headers))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class WebsiteTestTests(unittest.TestCase):
    def fetch(self, url="https://owned.example/", responses=None, **options):
        responses = responses if responses is not None else [FakeResponse()]
        connections = [FakeConnection(response) for response in responses]
        with patch.object(worker, "resolve_public", return_value=PUBLIC) as resolve, patch.object(
            worker, "PinnedHTTPSConnection", side_effect=connections
        ) as connect:
            report = worker.test_website(url, **options)
        return report, connections, resolve, connect

    def test_single_html_fetch_reports_without_assets_or_cookies(self):
        response = FakeResponse(body=b"<title>Owned &amp; tested</title><img src='/asset'><script src='/js'></script>")
        report, connections, resolve, connect = self.fetch(responses=[response])
        self.assertTrue(report["ok"])
        self.assertEqual(report["kind"], "website-load-test")
        self.assertEqual(report["title"], "Owned & tested")
        self.assertEqual(report["bytes"], len(response.body))
        self.assertEqual(report["final_url"], "https://owned.example/")
        self.assertEqual(report["redirects"], 0)
        self.assertIsInstance(report["total_ms"], float)
        self.assertEqual(connect.call_count, 1)
        self.assertEqual(resolve.call_count, 1)
        method, target, headers = connections[0].requests[0]
        self.assertEqual((method, target), ("GET", "/"))
        self.assertNotIn("Cookie", headers)
        self.assertNotIn("Authorization", headers)
        self.assertEqual(headers["Accept-Encoding"], "identity")
        self.assertTrue(response.closed)
        self.assertTrue(connections[0].closed)

    def test_reject_unsafe_input_without_dns_or_connection(self):
        urls = [
            "http://owned.example/", "https://user:pass@owned.example/", "https://owned.example:8443/",
            "https://owned.example/#fragment", "https://owned.example/?token=secret", "https://owned.example/#",
            "https://127.0.0.1/", "https://93.184.216.34/", "https://[::1]/", "https://localhost/",
            "https://device.local/", "https://device.internal/", "https://owned.example\\@evil.example/",
            "https://owned.example/\r\nInjected:bad", "https://owned.example./", "https://bad%2eexample/",
        ]
        for url in urls:
            with self.subTest(url=url):
                report, _, resolve, connect = self.fetch(url)
                self.assertFalse(report["ok"])
                self.assertIsNotNone(report["error"])
                resolve.assert_not_called()
                connect.assert_not_called()

    def test_private_or_mixed_dns_answers_rejected(self):
        for ip in ("127.0.0.1", "192.168.1.12", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"):
            family = socket.AF_INET6 if ":" in ip else socket.AF_INET
            answer = (family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443))
            public = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
            with self.subTest(ip=ip), patch.object(worker.socket, "getaddrinfo", return_value=[public, answer]):
                with self.assertRaises(worker.SafetyError):
                    worker.resolve_public("owned.example", time.monotonic() + 1)

    def test_public_dns_kept_for_pinned_connection(self):
        answer = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        with patch.object(worker.socket, "getaddrinfo", return_value=[answer, answer]) as lookup:
            addresses = worker.resolve_public("owned.example", time.monotonic() + 1)
            lookup.assert_called_once()
        self.assertEqual(addresses, PUBLIC)
        candidate = Mock()
        tls = Mock()
        context = Mock()
        context.wrap_socket.return_value = tls
        with patch.object(worker.ssl, "create_default_context", return_value=context), patch.object(
            worker.socket, "socket", return_value=candidate
        ), patch.object(worker.socket, "getaddrinfo") as second_lookup:
            connection = worker.PinnedHTTPSConnection("owned.example", addresses, time.monotonic() + 1)
            connection.connect()
            second_lookup.assert_not_called()
            candidate.connect.assert_called_once_with(("93.184.216.34", 443))
            context.wrap_socket.assert_called_once_with(candidate, server_hostname="owned.example")

    def test_dns_wait_is_bounded(self):
        unblock = threading.Event()

        def hung_lookup(*args, **kwargs):
            unblock.wait(1)
            return []

        started = time.monotonic()
        try:
            with patch.object(worker.socket, "getaddrinfo", side_effect=hung_lookup):
                with self.assertRaises(TimeoutError):
                    worker.resolve_public("owned.example", time.monotonic() + 0.02)
            self.assertLess(time.monotonic() - started, 0.5)
        finally:
            unblock.set()

    def test_redirect_unsafe_destinations_never_requested(self):
        for target in ("http://owned.example/", "https://other.example/", "https://127.0.0.1/", "https://owned.example:8443/", "https://owned.example/?token=x"):
            with self.subTest(target=target):
                redirect = FakeResponse(status=302, headers={"Location": target})
                report, _, resolve, connect = self.fetch(responses=[redirect])
                self.assertFalse(report["ok"])
                self.assertEqual(connect.call_count, 1)
                self.assertEqual(resolve.call_count, 1)
                self.assertEqual(redirect.read_sizes, [])

    def test_same_host_redirect_revalidates_dns_and_reports_final_url(self):
        redirect = FakeResponse(status=301, headers={"Location": "/new"})
        report, connections, resolve, connect = self.fetch(responses=[redirect, FakeResponse()])
        self.assertTrue(report["ok"])
        self.assertEqual(report["redirects"], 1)
        self.assertEqual(report["url"], "https://owned.example/")
        self.assertEqual(report["final_url"], "https://owned.example/new")
        self.assertEqual(connections[1].requests[0][1], "/new")
        self.assertEqual(resolve.call_count, 2)
        self.assertTrue(redirect.closed)

    def test_redirect_to_approved_host_still_rejects_private_dns(self):
        redirect = FakeResponse(status=302, headers={"Location": "https://other.example/"})
        connection = FakeConnection(redirect)
        with patch.object(worker, "resolve_public", side_effect=[PUBLIC, worker.SafetyError("Private address excluded")]) as resolve, patch.object(
            worker, "PinnedHTTPSConnection", return_value=connection
        ) as connect:
            report = worker.test_website("https://owned.example/", allowed_hosts=["owned.example", "other.example"])
        self.assertFalse(report["ok"])
        self.assertEqual(resolve.call_count, 2)
        self.assertEqual(connect.call_count, 1)

    def test_redirect_limit_and_loop(self):
        for locations in (("/a", "/b", "/c", "/d"), ("/a", "/")):
            with self.subTest(locations=locations):
                report, _, _, connect = self.fetch(responses=[FakeResponse(status=302, headers={"Location": item}) for item in locations])
                self.assertFalse(report["ok"])
                self.assertLessEqual(connect.call_count, 4)
                self.assertIn("Redirect", report["error"])

    def test_non_html_compression_and_error_status_do_not_download_bodies(self):
        responses = [
            FakeResponse(headers={"Content-Type": "video/mp4"}),
            FakeResponse(headers={"Content-Type": "text/html", "Content-Encoding": "gzip"}),
            FakeResponse(status=503),
        ]
        for response in responses:
            with self.subTest(headers=response.headers, status=response.status):
                report, _, _, _ = self.fetch(responses=[response])
                self.assertFalse(report["ok"])
                self.assertEqual(report["bytes"], 0)
                self.assertEqual(response.read_sizes, [])
                self.assertEqual(report["status"], response.status)

    def test_read_cap_is_strict_and_report_marks_partial_body(self):
        response = FakeResponse(body=b"0123456789" * 100)
        report, _, _, _ = self.fetch(responses=[response], max_bytes=37)
        self.assertTrue(report["ok"])
        self.assertTrue(report["truncated"])
        self.assertEqual(report["bytes"], 37)
        self.assertEqual(response.offset, 37)
        self.assertEqual(response.read_sizes, [37])

    def test_timeout_is_a_failure_without_retry(self):
        response = FakeResponse(error=TimeoutError("read timed out"))
        report, _, _, connect = self.fetch(responses=[response])
        self.assertFalse(report["ok"])
        self.assertEqual(report["error"], "read timed out")
        self.assertEqual(connect.call_count, 1)

    def test_total_deadline_interrupts_a_trickling_header(self):
        interrupted = threading.Event()
        connection = FakeConnection(FakeResponse())
        connection.sock.shutdown.side_effect = lambda *args: interrupted.set()

        def trickle_forever():
            if not interrupted.wait(0.5):
                raise AssertionError("The overall deadline did not interrupt the transport")
            raise TimeoutError("Header timed out")

        connection.getresponse = trickle_forever
        started = time.monotonic()
        with patch.object(worker, "resolve_public", return_value=PUBLIC), patch.object(worker, "PinnedHTTPSConnection", return_value=connection):
            report = worker.test_website("https://owned.example/", timeout=0.02)
        self.assertFalse(report["ok"])
        self.assertTrue(interrupted.is_set())
        self.assertLess(time.monotonic() - started, 0.4)
        self.assertTrue(connection.closed)

    def test_title_decoding_and_limit(self):
        body = ("<title>" + "\u00e9" * 2000 + "</title>").encode("latin-1")
        report, _, _, _ = self.fetch(responses=[FakeResponse(body=body, headers={"Content-Type": "text/html; charset=iso-8859-1"})])
        self.assertEqual(report["title"], "\u00e9" * 266)
        self.assertTrue(report["ok"])

    def test_initial_and_encoded_urls_must_fit_transport_limit(self):
        for url in ("https://owned.example/" + "a" * 512, "https://owned.example/" + "\u00e9" * 100):
            with self.subTest(url=url):
                report, _, resolve, connect = self.fetch(url)
                self.assertFalse(report["ok"])
                self.assertLessEqual(len(report["url"]), 512)
                resolve.assert_not_called()
                connect.assert_not_called()

    def test_worst_allowed_url_and_unicode_title_fit_4000_character_result(self):
        prefix = "https://owned.example/"
        url = prefix + "a" * (512 - len(prefix))
        # Non-BMP characters require twelve JSON characters with ensure_ascii.
        for glyph in ("\u4e00", "\U0001f680"):
            with self.subTest(glyph=glyph):
                response = FakeResponse(
                    body=("<title>" + glyph * 300 + "</title>").encode(),
                    headers={"Content-Type": "text/html; x=" + glyph * 200},
                )
                report, _, _, _ = self.fetch(url, responses=[response])
                self.assertTrue(report["ok"])
                self.assertEqual(len(report["url"]), 512)
                self.assertEqual(len(report["final_url"]), 512)
                serialized = json.dumps(report, ensure_ascii=True, separators=(",", ":"))
                self.assertLess(len(serialized), 4000)

    def test_invalid_unicode_url_and_long_error_fit_result_limit(self):
        report, _, _, _ = self.fetch("https://owned.example/" + "\U0001f680" * 512)
        self.assertFalse(report["ok"])
        self.assertLess(len(json.dumps(report, ensure_ascii=True)), 4000)
        with patch.object(worker, "resolve_public", side_effect=OSError("\U0001f680" * 500)):
            report = worker.test_website("https://owned.example/" + "a" * 490)
        self.assertFalse(report["ok"])
        self.assertLess(len(json.dumps(report, ensure_ascii=True)), 4000)

    def test_encoded_settings_and_invalid_settings_have_machine_reports(self):
        encoded = base64.b64encode(json.dumps({"url": "https://owned.example/"}).encode()).decode()
        expected = {"kind": worker.KIND, "ok": True, "url": "https://owned.example/"}
        output = io.StringIO()
        with patch.object(worker, "test_website", return_value=expected) as fetch, patch("sys.argv", ["worker", "--settings-b64", encoded]), redirect_stdout(output):
            self.assertEqual(worker.main(), 0)
        fetch.assert_called_once_with("https://owned.example/", None)
        self.assertEqual(json.loads(output.getvalue()), expected)
        for encoded in ("not-valid-base64!", base64.b64encode(b'{"url":"https://owned.example/","repeat":3}').decode()):
            with self.subTest(encoded=encoded), patch("sys.argv", ["worker", "--settings-b64", encoded]), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(worker.main(), 1)
                report = json.loads(output.getvalue())
                self.assertFalse(report["ok"])
                self.assertEqual(report["error"], "Invalid encoded URL settings.")


if __name__ == "__main__":
    unittest.main(verbosity=2)

