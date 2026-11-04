import asyncio
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from loadgate import LoadGate, LoadWatch  # noqa: E402


def watch():
    calls = []
    w = LoadWatch("cpu", on_unload=lambda: calls.append("unload"), on_reload=lambda: calls.append("reload"))
    return w, calls


class LoadWatchTests(unittest.TestCase):
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
