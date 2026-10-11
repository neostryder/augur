import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from loadgate import LoadWatch  # noqa: E402


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
