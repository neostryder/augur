import json
import os
import sys
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from pool import Pool, PoolError  # noqa: E402


def serve(load=None, post=(200, {"ok": True})):
    """A stand-in Laya server. `load` is the /load body (or None for a 404), `post` the status and body of /v1/systemone."""
    hits = {"load": 0, "post": 0}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            hits["load"] += 1
            self._send(200, load) if load is not None else self._send(404, {})

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            hits["post"] += 1
            self._send(*post)

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, hits, f"http://127.0.0.1:{srv.server_address[1]}"


class PoolTests(unittest.TestCase):
    def setUp(self):
        self.stops = []
        self.now = [0.0]

    def tearDown(self):
        for s in self.stops:
            s.shutdown()

    def s(self, **kw):
        srv, hits, url = serve(**kw)
        self.stops.append(srv)
        return hits, url

    def pool(self, *urls):
        return Pool([{"name": f"s{i}", "url": u} for i, u in enumerate(urls)], clock=lambda: self.now[0])

    def test_uses_the_first_server_when_it_is_healthy(self):
        h1, u1 = self.s(load={"busy": False, "ready": True})
        h2, u2 = self.s(load={"busy": False, "ready": True})
        out, name = self.pool(u1, u2).post("/v1/systemone", {})
        self.assertEqual((out, name), ({"ok": True}, "s0"))
        self.assertEqual(h2["post"], 0)

    def test_skips_a_busy_server_and_remembers_it_for_a_few_seconds(self):
        h1, u1 = self.s(load={"busy": True, "reasons": ["GPU use over 80%"], "ready": True})
        h2, u2 = self.s(load={"busy": False, "ready": True})
        p = self.pool(u1, u2)
        self.assertEqual(p.post("/v1/systemone", {})[1], "s1")
        p.post("/v1/systemone", {})
        self.assertEqual(h1["load"], 1)   # not asked again inside the window
        self.now[0] = 6.0
        p.post("/v1/systemone", {})
        self.assertEqual(h1["load"], 2)

    def test_skips_an_unreachable_server_for_half_a_minute(self):
        h2, u2 = self.s(load=None)
        p = self.pool("http://127.0.0.1:9", u2)
        self.assertEqual(p.post("/v1/systemone", {})[1], "s1")
        self.assertIn("unreachable", p._skip["http://127.0.0.1:9"][1])
        self.assertGreater(p._skip["http://127.0.0.1:9"][0], 29)

    def test_a_503_from_the_call_itself_moves_on(self):
        h1, u1 = self.s(load=None, post=(503, {"error": "busy"}))
        h2, u2 = self.s(load=None)
        self.assertEqual(self.pool(u1, u2).post("/v1/systemone", {})[1], "s1")

    def test_a_client_error_is_raised_and_not_retried(self):
        h1, u1 = self.s(load=None, post=(422, {"error": "bad"}))
        h2, u2 = self.s(load=None)
        with self.assertRaises(urllib.error.HTTPError):
            self.pool(u1, u2).post("/v1/systemone", {})
        self.assertEqual(h2["post"], 0)

    def test_reports_every_reason_when_nothing_answers(self):
        h1, u1 = self.s(load={"busy": True, "reasons": ["video memory over 80%"], "ready": True})
        with self.assertRaises(PoolError) as cm:
            self.pool(u1, "http://127.0.0.1:9").post("/v1/systemone", {})
        self.assertIn("video memory over 80%", cm.exception.reasons["s0"])
        self.assertIn("unreachable", cm.exception.reasons["s1"])

    def test_a_server_that_is_not_ready_is_skipped(self):
        h1, u1 = self.s(load={"busy": False, "ready": False})
        h2, u2 = self.s(load={"busy": False, "ready": True})
        self.assertEqual(self.pool(u1, u2).post("/v1/systemone", {})[1], "s1")


if __name__ == "__main__":
    unittest.main()
