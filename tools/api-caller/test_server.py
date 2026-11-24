import http.client
import json
import subprocess
import threading
import unittest
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError

import server


class CatalogTest(unittest.TestCase):
    def test_cli_output_is_utf8_even_on_korean_windows(self):
        title = "버전 확인 🧪"
        result = subprocess.CompletedProcess([], 0, title.encode("utf-8"), b"")
        with patch.object(subprocess, "run", return_value=result) as run:
            self.assertEqual(server.github_command("api", "fixture"), title)
        self.assertFalse(run.call_args.kwargs.get("text", False))

    def test_empty_catalog_does_not_authenticate(self):
        with patch.object(server, "github_command", return_value="[[]]"), patch.object(server, "registry_token") as auth:
            self.assertEqual(server.list_prs(), [])
            auth.assert_not_called()

    def test_prs_remain_available_before_or_without_package_access(self):
        raw = json.dumps([[{"number": 7, "title": "변경", "head": {"sha": "a" * 40}}]])
        failure = HTTPError("https://example.invalid", 403, "403", {}, None)
        with patch.object(server, "github_command", return_value=raw), patch.object(server, "registry_token", side_effect=failure) as auth:
            result = server.list_prs(include_images=False)
            self.assertEqual(result[0]["number"], 7)
            auth.assert_not_called()
            self.assertIn("403", server.list_prs()[0]["imageLabel"])


class FixtureUpstream(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/container-2/pr-17/version":
            self.send_response(302)
            self.send_header("Location", "/canonical/version")
            self.end_headers()
            return
        responses = {
            "/canonical/version": (200, b'{"version":"1.0.5"}'),
            "/container-2/main/environment": (200, b'{"prNumber":"main"}'),
            "/container-2/pr-170/health": (503, b'{"status":"waiting"}'),
            "/container-2/pr-1/version": (200, b"v" * (server.MAX_RESPONSE + 2)),
            "/container-2/pr-2/version": (200, b"v" * server.MAX_RESPONSE),
            "/container-2/pr-3/version": (200, b"NaN"),
        }
        status, body = responses.get(self.path, (404, b""))
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class QuietCaller(server.Handler):
    def log_message(self, *args):
        pass


class CallerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        stack = ExitStack()
        cls.addClassCleanup(stack.close)
        def start(handler):
            httpd = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), handler))
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            stack.callback(thread.join)
            stack.callback(httpd.shutdown)
            return httpd.server_port
        cls.upstream = start(FixtureUpstream)
        cls.caller = start(QuietCaller)

    def request(self, body):
        conn = http.client.HTTPConnection("127.0.0.1", self.caller, timeout=5)
        try:
            conn.request("POST", "/api/call", json.dumps(body), {"Content-Type": "application/json"})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def call(self, pr, endpoint, **options):
        params = {"baseUrl": f"http://127.0.0.1:{self.upstream}/container-2",
                  "prNumber": pr, "endpoint": endpoint, **options}
        return self.request(params)

    def test_redirect_records_both_targets(self):
        status, data = self.call(17, "version")
        self.assertEqual((status, data["status"], data["body"]), (200, 200, {"version": "1.0.5"}))
        self.assertTrue(data["url"].endswith("/pr-17/version"))
        self.assertTrue(data["finalUrl"].endswith("/canonical/version"))

    def test_main_and_upstream_failure(self):
        self.assertEqual(self.call(17, "environment", isMain=True)[1]["body"]["prNumber"], "main")
        result = self.call(170, "health")[1]
        self.assertEqual((result["ok"], result["status"], result["body"]), (False, 503, {"status": "waiting"}))

    def test_response_cap_is_explicit(self):
        for pr, expected in [(1, True), (2, False)]:
            with self.subTest(pr=pr):
                result = self.call(pr, "version")[1]
                self.assertEqual(result["truncated"], expected)
                self.assertEqual(len(result["body"]), server.MAX_RESPONSE)
        self.assertEqual(self.call(3, "version")[1]["body"], "NaN")

    def test_invalid_inputs_return_json(self):
        self.assertEqual(self.request([])[0], 400)
        self.assertEqual(self.call("0", "health")[0], 400)
        self.assertEqual(self.call("17", "health", isMain="true")[0], 400)
        self.assertEqual(self.call("17", "health", baseUrl="http://localhost:wrong/container-2")[0], 400)
