import asyncio
import json
import os
import socket
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.request import urlopen

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from loadgate import LoadGate, LoadWatch  # noqa: E402


def watch():
    calls = []
    w = LoadWatch("cpu", on_unload=lambda: calls.append("unload"), on_reload=lambda: calls.append("reload"))
    return w, calls


class LoadWatchTests(unittest.TestCase):
    def test_a_sampling_failure_still_detects_a_game_and_unloads(self):
        w, calls = watch()
        with patch("loadgate.running_games", return_value=["ArkAscended.exe"]) as games:
            def sample():
                games.assert_called_with(w.game_names)
                raise ImportError("NVML missing")

            with patch.object(w, "sample", side_effect=sample):
                w.tick(0)
                self.assertTrue(w.busy)
                self.assertEqual(w.reasons, ["ArkAscended.exe running"])
                w.tick(5)
        self.assertEqual(calls, ["unload"])
        self.assertEqual(w.unload_reason, "game")

    def test_sample_error_is_reported_and_clears_after_a_good_sample(self):
        w, _ = watch()
        self.assertIsNone(w.status()["sample_error"])
        with patch("loadgate.running_games", return_value=[]):
            with patch.object(w, "sample", side_effect=ImportError("NVML missing")):
                w.tick(0)
            self.assertEqual(w.sample_error, "NVML missing")
            self.assertEqual(w.status()["sample_error"], "NVML missing")
            self.assertEqual((w.gpu_util, w.vram_other_pct), (0.0, 0.0))
            with patch.object(w, "sample", return_value=(90, 85)):
                w.tick(1)
        self.assertIsNone(w.sample_error)
        self.assertIsNone(w.status()["sample_error"])
        self.assertEqual(w.vram_other_pct, 85)
        self.assertTrue(w.busy)

    def test_sampling_failures_clear_game_busy_only_after_the_calm_period(self):
        w, calls = watch()
        with patch.object(w, "sample", side_effect=ImportError("NVML missing")):
            with patch("loadgate.running_games", return_value=["ArkAscended.exe"]):
                w.tick(0)
                w.tick(5)
            with patch("loadgate.running_games", return_value=[]):
                w.tick(6)
                w.tick(15)
                self.assertTrue(w.busy)
                w.tick(16)
        self.assertFalse(w.busy)
        self.assertEqual(calls, ["unload"])

    def test_sampling_failures_still_allow_idle_unloading(self):
        w, calls = watch()
        w.touch(0)
        with patch("loadgate.running_games", return_value=[]):
            with patch.object(w, "sample", side_effect=ImportError("NVML missing")):
                w.tick(600)
        self.assertEqual(calls, ["unload"])
        self.assertEqual(w.unload_reason, "idle")

    def test_sampling_failures_still_allow_a_busy_unload_to_reload_after_calm(self):
        w, calls = watch()
        w.step(0, 90, 0)
        w.step(0, 90, 30)
        with patch("loadgate.running_games", return_value=[]):
            with patch.object(w, "sample", side_effect=ImportError("NVML missing")):
                w.tick(31)
                self.assertTrue(w.busy)
                w.tick(41)
        self.assertFalse(w.busy)
        self.assertEqual(calls, ["unload", "reload"])

    def test_a_lone_spike_does_not_make_the_card_busy(self):
        w, _ = watch()
        for t, u in enumerate([10, 10, 95, 10, 10]):
            w.step(u, 20, t)
        self.assertFalse(w.busy)

    def test_sustained_use_over_the_limit_is_busy_and_says_why(self):
        w, _ = watch()
        for t in range(5):
            w.step(90, 20, t)
        self.assertTrue(w.busy)
        self.assertEqual(w.reasons, ["GPU use over 80%"])
        self.assertFalse(w.status()["ready"] and not w.busy)

    def test_video_memory_held_by_other_processes_is_busy(self):
        w, _ = watch()
        w.step(5, 85, 0)
        self.assertTrue(w.busy)
        self.assertEqual(w.reasons, ["video memory over 80%"])

    def test_it_unloads_after_thirty_seconds_busy_and_reloads_after_ten_seconds_calm(self):
        w, calls = watch()
        for t in range(0, 29):
            w.step(5, 90, t)
        self.assertEqual(calls, [])
        w.step(5, 90, 30)
        self.assertEqual(calls, ["unload"])
        w.step(5, 90, 31)
        self.assertEqual(calls, ["unload"])   # only once
        w.step(5, 50, 40)   # calm starts
        w.step(5, 50, 49)
        self.assertTrue(w.busy)
        w.step(5, 50, 51)
        self.assertFalse(w.busy)
        self.assertEqual(calls, ["unload", "reload"])

    def test_a_busy_unload_is_not_ready_until_it_reloads(self):
        w, _ = watch()
        for t in range(0, 31):
            w.step(5, 90, t)
        self.assertEqual(w.unload_reason, "busy")
        self.assertFalse(w.status()["ready"])

    def test_between_the_limit_and_ten_points_under_it_stays_busy(self):
        w, _ = watch()
        w.step(5, 90, 0)
        for t in range(1, 40):
            w.step(5, 75, t)
        self.assertTrue(w.busy)

    def test_our_own_work_is_not_counted_against_us(self):
        w, _ = watch()
        w.inflight = 1
        for t in range(10):
            w.step(100, 10, t)
        self.assertFalse(w.busy)

    def test_a_game_is_busy_at_once_and_the_checkpoints_leave_after_five_seconds(self):
        w, calls = watch()
        w.step(5, 20, 0, ["ArkAscended.exe"])
        self.assertTrue(w.busy)
        self.assertEqual(w.reasons, ["ArkAscended.exe running"])
        w.step(5, 20, 4, ["ArkAscended.exe"])
        self.assertEqual(calls, [])
        w.step(5, 20, 5, ["ArkAscended.exe"])
        self.assertEqual(calls, ["unload"])
        self.assertEqual(w.unload_reason, "game")

    def test_after_a_game_the_card_is_free_again_but_nothing_reloads_until_a_request(self):
        w, calls = watch()
        w.step(5, 20, 0, ["ArkAscended.exe"])
        w.step(5, 20, 6, ["ArkAscended.exe"])
        w.step(5, 20, 10)
        w.step(5, 20, 21)
        self.assertFalse(w.busy)
        self.assertEqual(calls, ["unload"])
        self.assertTrue(w.status()["checkpoints_in_memory"] is False)
        self.assertTrue(w.status()["ready"])   # a client must still send the request that loads them
        w.mark_loaded()
        self.assertTrue(w.status()["checkpoints_in_memory"])

    def test_an_idle_server_unloads_after_ten_minutes_and_a_request_resets_the_clock(self):
        w, calls = watch()
        w.touch(0)
        w.step(5, 20, 599)
        self.assertEqual(calls, [])
        w.touch(600)
        w.step(5, 20, 1100)
        self.assertEqual(calls, [])
        w.step(5, 20, 1200)
        self.assertEqual(calls, ["unload"])
        self.assertEqual(w.unload_reason, "idle")
        self.assertTrue(w.status()["ready"] and not w.status()["busy"])
        w.step(5, 20, 1300)
        self.assertEqual(calls, ["unload"])   # once, and no eager reload

    def test_a_request_in_flight_keeps_an_idle_server_loaded(self):
        w, calls = watch()
        w.touch(0)
        w.inflight = 1
        w.step(5, 20, 5000)
        self.assertEqual(calls, [])

    def test_idle_unload_can_be_turned_off(self):
        w, calls = watch()
        w.idle_unload_after = 0
        w.touch(0)
        w.step(5, 20, 100000)
        self.assertEqual(calls, [])

    def test_yield_unloads_at_once_as_an_idle_unload_that_nothing_reverses(self):
        w, calls = watch()
        w.mark_loaded()
        self.assertTrue(w.yield_now())
        self.assertEqual(calls, ["unload"])
        self.assertTrue(w.unloaded)
        self.assertEqual(w.unload_reason, "idle")
        status = w.status()
        self.assertTrue(status["ready"])
        self.assertFalse(status["checkpoints_in_memory"])
        w.step(5, 20, 100)
        w.step(5, 20, 100000)
        self.assertEqual(calls, ["unload"])   # no reload and no second unload on its own

    def test_yield_with_nothing_in_memory_answers_false_and_unloads_nothing(self):
        w, calls = watch()
        w.unloaded, w.unload_reason = True, "idle"   # how serve_lora.py starts: nothing in memory until a request
        self.assertFalse(w.yield_now())
        w.mark_loaded()
        w.yield_now()
        self.assertFalse(w.yield_now())
        self.assertEqual(calls, ["unload"])

    def test_yield_during_a_busy_unload_keeps_the_busy_reason(self):
        w, calls = watch()
        for t in range(0, 31):
            w.step(5, 90, t)
        self.assertEqual(calls, ["unload"])
        self.assertFalse(w.yield_now())
        self.assertEqual(w.unload_reason, "busy")
        self.assertEqual(calls, ["unload"])

class YieldRouteTests(unittest.TestCase):
    def call(self, w, client=("127.0.0.1", 50000), headers=(), method="POST", path="/yield"):
        reached = []

        async def app(scope, receive, send):
            reached.append(scope["path"])
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        sent = []

        async def send(message):
            sent.append(message)

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        scope = {"type": "http", "path": path, "method": method, "client": client, "headers": list(headers)}
        asyncio.run(LoadGate(app, w)(scope, receive, send))
        status = sent[0]["status"]
        body = b"".join(m.get("body", b"") for m in sent[1:])
        return status, (json.loads(body) if body else None), reached

    def test_a_local_request_frees_the_memory_and_answers_with_json(self):
        w, calls = watch()
        w.mark_loaded()
        status, body, reached = self.call(w)
        self.assertEqual(status, 200)
        self.assertEqual(body, {"yielded": True, "checkpoints_in_memory": False})
        self.assertEqual(calls, ["unload"])
        self.assertEqual(reached, [])

    def test_it_answers_200_when_nothing_was_loaded(self):
        w, calls = watch()
        w.unloaded, w.unload_reason = True, "idle"
        status, body, _ = self.call(w, client=("::1", 50000))
        self.assertEqual((status, body), (200, {"yielded": False, "checkpoints_in_memory": False}))
        self.assertEqual(calls, [])

    def test_a_request_from_another_machine_is_refused(self):
        w, calls = watch()
        w.mark_loaded()
        status, _, _ = self.call(w, client=("192.168.2.40", 50000))
        self.assertEqual(status, 403)
        self.assertEqual(calls, [])
        self.assertFalse(w.unloaded)

    def test_a_request_with_an_origin_header_is_refused(self):
        w, calls = watch()
        w.mark_loaded()
        status, _, _ = self.call(w, headers=[(b"origin", b"https://example.com")])
        self.assertEqual(status, 403)
        self.assertEqual(calls, [])

    def test_a_missing_client_address_is_refused(self):
        w, calls = watch()
        w.mark_loaded()
        status, _, _ = self.call(w, client=None)
        self.assertEqual(status, 403)
        self.assertEqual(calls, [])

    def test_only_post_reaches_the_route(self):
        w, calls = watch()
        w.mark_loaded()
        _, _, reached = self.call(w, method="GET")
        self.assertEqual(reached, ["/yield"])
        self.assertEqual(calls, [])


class FailoverTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"LAYA_FAILOVER_URLS": "", "LAYA_FAILOVER_PROBE_S": "2",
                                      "LAYA_FAILOVER_TIMEOUT_S": "120"})
        env.start()
        self.addCleanup(env.stop)
        self.w, _ = watch()
        self.w.busy = True
        self.w.reasons = ["ArkAscended.exe running"]
        self.w.touch(100)

    def upstream(self, busy=False, ready=True, status=201, body=b'{"answer": "ok"}', load_body=None, load_status=200):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append((self.path, None, dict(self.headers)))
                data = json.dumps({"ready": ready, "busy": busy}).encode() if load_body is None else load_body
                self.answer(load_status, data)

            def do_POST(self):
                data = self.rfile.read(int(self.headers.get("content-length", "0")))
                received.append((self.path, data, dict(self.headers)))
                if status is None:
                    self.close_connection = True
                    return
                self.answer(status, body)

            def answer(self, code, data):
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join()

        self.addCleanup(stop)
        return f"http://127.0.0.1:{server.server_port}", received

    def down_url(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.addCleanup(sock.close)
        return f"http://127.0.0.1:{sock.getsockname()[1]}"

    def call(self, urls=None, body=b'{"prompt": "hello"}', headers=(), messages=None,
             path="/v1/systemone", method="POST", expect_app=False):
        if urls is not None:
            os.environ["LAYA_FAILOVER_URLS"] = ",".join(urls)
        reached, sent = [], []
        incoming = iter(messages if messages is not None else [{"type": "http.request", "body": body}])

        async def app(scope, receive, send):
            reached.append(scope["path"])
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})

        async def receive():
            return next(incoming)

        async def send(message):
            sent.append(message)

        scope = {"type": "http", "path": path, "method": method, "headers": list(headers),
                 "client": ("127.0.0.1", 50000)}
        asyncio.run(LoadGate(app, self.w)(scope, receive, send))
        self.assertEqual(reached, [path] if expect_app else [])
        if not sent:
            return None, b"", {}
        return sent[0]["status"], b"".join(m.get("body", b"") for m in sent[1:]), dict(sent[0]["headers"])

    def assert_busy(self, response):
        status, body, headers = response
        self.assertEqual(status, 503)
        self.assertEqual(body, json.dumps({"error": "busy", "reasons": self.w.reasons, "retry_after_s": 5}).encode())
        self.assertEqual(headers, {b"content-type": b"application/json", b"content-length": str(len(body)).encode(),
                                   b"retry-after": b"5"})
        self.assertEqual((self.w.inflight, self.w.requests, self.w.last_active), (0, 0, 100))

    def test_a_busy_post_without_failover_urls_keeps_the_original_response(self):
        for urls in (None, [], ["   "]):
            with self.subTest(urls=urls):
                os.environ.pop("LAYA_FAILOVER_URLS", None)
                self.assert_busy(self.call(urls))

    def test_a_busy_post_forwards_body_and_only_the_selected_request_headers(self):
        url, received = self.upstream()
        body = b'{"prompt": "hello"}'
        status, data, headers = self.call([" " + url + "/ "], body=body,
                                         headers=[(b"content-type", b"application/custom+json"),
                                                  (b"origin", b"https://example.com"),
                                                  (b"cookie", b"session=test"), (b"authorization", b"Bearer test")])
        self.assertEqual((status, data), (201, b'{"answer": "ok"}'))
        self.assertEqual(headers[b"content-type"], b"application/json")
        self.assertEqual(headers[b"x-laya-served-by"], url.encode())
        self.assertEqual(headers[b"content-length"], str(len(data)).encode())
        self.assertEqual([r[0] for r in received], ["/load", "/v1/systemone"])
        self.assertEqual(received[1][1], body)
        sent_headers = {k.lower(): v for k, v in received[1][2].items()}
        self.assertEqual(sent_headers["content-type"], "application/custom+json")
        self.assertEqual(sent_headers["x-laya-forwarded"], "1")
        for name in ("origin", "cookie", "authorization"):
            self.assertNotIn(name, sent_headers)
        self.assertEqual((self.w.inflight, self.w.requests, self.w.last_active), (0, 0, 100))

    def test_a_busy_first_server_is_skipped(self):
        first, skipped = self.upstream(busy=True)
        second, received = self.upstream()
        status, _, headers = self.call([first, second])
        self.assertEqual(status, 201)
        self.assertEqual(headers[b"x-laya-served-by"], second.encode())
        self.assertEqual([r[0] for r in skipped], ["/load"])
        self.assertEqual([r[0] for r in received], ["/load", "/v1/systemone"])

    def test_a_down_first_server_is_skipped(self):
        second, received = self.upstream()
        status, _, headers = self.call([self.down_url(), second])
        self.assertEqual(status, 201)
        self.assertEqual(headers[b"x-laya-served-by"], second.encode())
        self.assertEqual(len(received), 2)

    def test_a_forwarded_header_with_any_value_prevents_another_forward(self):
        url, received = self.upstream()
        for value in (b"", b"0", b"1"):
            with self.subTest(value=value):
                self.assert_busy(self.call([url], headers=[(b"x-laya-forwarded", value)]))
        self.assertEqual(received, [])

    def test_an_upstream_client_error_is_returned_without_trying_the_next_server(self):
        first, _ = self.upstream(status=422, body=b'{"error":"bad input"}')
        second, received = self.upstream()
        status, body, headers = self.call([first, second])
        self.assertEqual((status, body), (422, b'{"error":"bad input"}'))
        self.assertEqual(headers[b"x-laya-served-by"], first.encode())
        self.assertEqual(received, [])

    def test_an_upstream_server_error_tries_the_next_server(self):
        first, failed = self.upstream(status=503)
        second, _ = self.upstream()
        status, _, headers = self.call([first, second])
        self.assertEqual(status, 201)
        self.assertEqual(headers[b"x-laya-served-by"], second.encode())
        self.assertEqual(len(failed), 2)

    def test_an_upstream_post_connection_failure_tries_the_next_server(self):
        first, failed = self.upstream(status=None)
        second, _ = self.upstream()
        status, _, headers = self.call([first, second])
        self.assertEqual(status, 201)
        self.assertEqual(headers[b"x-laya-served-by"], second.encode())
        self.assertEqual(len(failed), 2)

    def test_an_upstream_probe_error_tries_the_next_server(self):
        first, failed = self.upstream(load_status=503)
        second, _ = self.upstream()
        status, _, headers = self.call([first, second])
        self.assertEqual(status, 201)
        self.assertEqual(headers[b"x-laya-served-by"], second.encode())
        self.assertEqual(len(failed), 1)

    def test_forwarding_runs_in_the_executor_with_configured_timeouts(self):
        url, _ = self.upstream()
        calls = []
        caller = threading.get_ident()

        def open_upstream(request, timeout):
            calls.append((threading.get_ident(), timeout))
            return urlopen(request, timeout=timeout)

        with patch.dict(os.environ, {"LAYA_FAILOVER_PROBE_S": "0.5", "LAYA_FAILOVER_TIMEOUT_S": "1.5"}):
            with patch("loadgate.urlopen", side_effect=open_upstream):
                status, _, _ = self.call([url])
        self.assertEqual(status, 201)
        self.assertEqual([timeout for _, timeout in calls], [0.5, 1.5])
        for thread, _ in calls:
            self.assertNotEqual(thread, caller)

    def test_all_failed_upstreams_keep_the_original_busy_response(self):
        failed, _ = self.upstream(status=500)
        busy, _ = self.upstream(busy=True)
        self.assert_busy(self.call([failed, self.down_url(), busy]))

    def test_a_chunked_body_is_forwarded_intact_with_the_default_content_type(self):
        url, received = self.upstream()
        status, _, _ = self.call([url], messages=[{"type": "http.request", "body": b'{"prompt":', "more_body": True},
                                                {"type": "http.request", "body": b'"hello"}', "more_body": False}])
        self.assertEqual(status, 201)
        self.assertEqual(received[1][1], b'{"prompt":"hello"}')
        self.assertEqual(received[1][2]["Content-Type"], "application/json")

    def test_a_disconnect_during_the_body_does_not_forward(self):
        url, received = self.upstream()
        response = self.call([url], messages=[{"type": "http.request", "body": b"partial", "more_body": True},
                                             {"type": "http.disconnect"}])
        self.assertEqual(response, (None, b"", {}))
        self.assertEqual(received, [])
        self.assertEqual((self.w.inflight, self.w.requests, self.w.last_active), (0, 0, 100))

    def test_an_unready_server_is_skipped(self):
        first, skipped = self.upstream(ready=False)
        second, _ = self.upstream()
        status, _, headers = self.call([first, second])
        self.assertEqual(status, 201)
        self.assertEqual(headers[b"x-laya-served-by"], second.encode())
        self.assertEqual(len(skipped), 1)

    def test_invalid_probe_responses_are_skipped(self):
        for body in (b"invalid JSON", b"[]", b'{"ready":true}', b'{"ready":1,"busy":false}'):
            with self.subTest(body=body):
                url, received = self.upstream(load_body=body)
                self.assert_busy(self.call([url]))
                self.assertEqual(len(received), 1)

    def test_a_non_busy_request_runs_locally_and_counts_as_activity(self):
        url, received = self.upstream()
        self.w.busy = False
        status, _, _ = self.call([url], expect_app=True)
        self.assertEqual(status, 204)
        self.assertEqual(received, [])
        self.assertEqual((self.w.inflight, self.w.requests), (0, 1))
        self.assertGreater(self.w.last_active, 100)

    def test_other_methods_and_routes_never_forward(self):
        url, received = self.upstream()
        with patch("loadgate.empty_cuda_cache"):
            for path, method, expect_app in (("/v1/systemone", "GET", True), ("/load", "GET", False),
                                             ("/load", "POST", True), ("/yield", "POST", False),
                                             ("/other", "POST", True)):
                with self.subTest(path=path, method=method):
                    self.call([url], path=path, method=method, expect_app=expect_app)
        self.assertEqual(received, [])
        self.assertEqual((self.w.inflight, self.w.requests, self.w.last_active), (0, 0, 100))


class RunningGamesTests(unittest.TestCase):
    def test_no_names_means_none_and_a_missing_program_is_not_found(self):
        from loadgate import running_games
        self.assertEqual(running_games([]), [])
        self.assertEqual(running_games(["definitely-not-running-xyz.exe"]), [])

    @unittest.skipUnless(os.name == "nt", "process list is read on Windows only")
    def test_it_finds_a_running_program_by_name_without_case(self):
        from loadgate import running_games
        self.assertEqual(running_games([os.path.basename(sys.executable).upper()]), [os.path.basename(sys.executable)])


if __name__ == "__main__":
    unittest.main()
