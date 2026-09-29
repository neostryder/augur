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


if __name__ == "__main__":
    unittest.main()
