import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import gate  # noqa: E402


def recs(pairs):
    return [([p, 1 - p], 0 if truth else 1) for p, truth in pairs]


class Metrics(unittest.TestCase):
    def test_perfect_and_confident_is_zero_brier(self):
        m = gate.summarize([([1.0, 0.0], 0), ([0.0, 1.0], 1)])
        self.assertEqual(m["brier"], 0.0)
        self.assertEqual(m["exact"], 1.0)
        self.assertEqual(m["ece"], 0.0)

    def test_overconfident_wrong_answers_raise_brier_and_ece(self):
        sure_wrong = gate.summarize([([0.9, 0.1], 1)] * 10)
        hedged_wrong = gate.summarize([([0.6, 0.4], 1)] * 10)
        self.assertGreater(sure_wrong["brier"], hedged_wrong["brier"])
        self.assertGreater(sure_wrong["ece"], hedged_wrong["ece"])

    def test_calibrated_hedging_has_zero_ece(self):
        # 70% confident and right 7 times in 10
        records = [([0.7, 0.3], 0)] * 7 + [([0.7, 0.3], 1)] * 3
        self.assertAlmostEqual(gate.summarize(records)["ece"], 0.0, places=3)

    def test_within_one_only_for_ordered_questions(self):
        records = [([0.1, 0.8, 0.1], 2)]
        self.assertEqual(gate.summarize(records, ordered=True)["within1"], 1.0)
        self.assertEqual(gate.summarize(records, ordered=False)["within1"], 0.0)

    def test_by_class_reports_recall_per_true_option(self):
        records = [([0.9, 0.1], 0)] * 4 + [([0.9, 0.1], 1)] * 2
        by = gate.summarize(records)["by_class"]
        self.assertEqual(by["0"]["recall"], 1.0)
        self.assertEqual(by["1"]["recall"], 0.0)
        self.assertEqual(by["1"]["n"], 2)

    def test_aurc_rewards_confidence_that_tracks_correctness(self):
        good = [([0.95, 0.05], 0)] * 5 + [([0.55, 0.45], 1)] * 5
        bad = [([0.95, 0.05], 1)] * 5 + [([0.55, 0.45], 0)] * 5
        self.assertLess(gate.aurc(good), gate.aurc(bad))

    def test_late_half_needs_enough_rows(self):
        self.assertNotIn("late", gate.summarize(recs([(0.8, True)] * 60)))
        self.assertEqual(gate.summarize(recs([(0.8, True)] * 100))["late"]["n"], 50)

    def test_late_half_sees_drift(self):
        early = [([0.9, 0.1], 0)] * 50
        late = [([0.9, 0.1], 1)] * 50
        m = gate.summarize(early + late)
        self.assertEqual(m["late"]["exact"], 0.0)
        self.assertGreater(m["late"]["brier"], m["brier"])

    def test_empty_records(self):
        self.assertEqual(gate.summarize([]), {"n": 0})

    def test_latency_is_reported_when_timed(self):
        self.assertEqual(gate.summarize(recs([(0.8, True)] * 10), seconds=2.0)["ms_per_row"], 200.0)


def m(exact, nll, brier, ece, n=400, late=None):
    out = {"n": n, "exact": exact, "nll": nll, "brier": brier, "ece": ece}
    if late is not None:
        out["late"] = {"n": n // 2, "exact": exact, "brier": late}
    return out


class Decide(unittest.TestCase):
    def test_clear_accuracy_win_promotes(self):
        v = gate.decide({"p/q": m(0.80, 0.5, 0.30, 0.05)}, {"p/q": m(0.70, 0.6, 0.35, 0.06)})
        self.assertTrue(v["promote"])
        self.assertEqual(v["wins"], ["p/q"])

    def test_accuracy_win_with_worse_calibration_is_held(self):
        v = gate.decide({"p/q": m(0.80, 0.5, 0.30, 0.20)}, {"p/q": m(0.70, 0.6, 0.35, 0.06)})
        self.assertFalse(v["promote"])
        self.assertIn("ece", v["questions"]["p/q"]["why"][0])

    def test_brier_regression_is_held(self):
        v = gate.decide({"p/q": m(0.80, 0.5, 0.40, 0.05)}, {"p/q": m(0.70, 0.6, 0.35, 0.06)})
        self.assertFalse(v["promote"])

    def test_equal_accuracy_better_calibration_promotes(self):
        v = gate.decide({"p/q": m(0.70, 0.55, 0.30, 0.03)}, {"p/q": m(0.70, 0.60, 0.35, 0.06)})
        self.assertTrue(v["promote"])

    def test_level_everywhere_is_held(self):
        v = gate.decide({"p/q": m(0.70, 0.60, 0.35, 0.06)}, {"p/q": m(0.70, 0.60, 0.35, 0.06)})
        self.assertFalse(v["promote"])
        self.assertEqual(v["questions"]["p/q"]["verdict"], "level")

    def test_accuracy_loss_on_any_question_blocks_a_win_elsewhere(self):
        cand = {"p/a": m(0.80, 0.5, 0.30, 0.05), "p/b": m(0.60, 0.7, 0.35, 0.06)}
        inc = {"p/a": m(0.70, 0.6, 0.35, 0.06), "p/b": m(0.65, 0.6, 0.35, 0.06)}
        v = gate.decide(cand, inc)
        self.assertFalse(v["promote"])
        self.assertEqual(v["losses"], ["p/b"])

    def test_new_question_without_incumbent_wins(self):
        self.assertTrue(gate.decide({"p/q": m(0.7, 0.6, 0.3, 0.05)}, {})["promote"])

    def test_newest_half_regression_is_held(self):
        cand = {"p/q": m(0.80, 0.5, 0.30, 0.05, late=0.50)}
        inc = {"p/q": m(0.70, 0.6, 0.35, 0.06, late=0.30)}
        v = gate.decide(cand, inc)
        self.assertFalse(v["promote"])
        self.assertIn("newest-half", v["questions"]["p/q"]["why"][0])

    def test_small_test_set_is_flagged_not_blocked_by_default(self):
        v = gate.decide({"p/q": m(0.80, 0.5, 0.30, 0.05, n=120)}, {"p/q": m(0.70, 0.6, 0.35, 0.06, n=120)})
        self.assertTrue(v["promote"])
        self.assertEqual(v["underpowered"], ["p/q"])

    def test_require_n_blocks_a_small_test_set(self):
        v = gate.decide({"p/q": m(0.80, 0.5, 0.30, 0.05, n=120)}, {"p/q": m(0.70, 0.6, 0.35, 0.06, n=120)}, require_n=300)
        self.assertFalse(v["promote"])
        self.assertIn("300 required", v["questions"]["p/q"]["why"][0])

    def test_require_n_blocks_a_new_question_too(self):
        v = gate.decide({"p/q": m(0.80, 0.5, 0.30, 0.05, n=50)}, {}, require_n=300)
        self.assertFalse(v["promote"])

    def test_old_metrics_without_brier_still_compare_on_accuracy(self):
        cand = {"p/q": {"n": 400, "exact": 0.8, "nll": 0.5, "ece": 0.05}}
        inc = {"p/q": {"n": 400, "exact": 0.7, "nll": 0.6, "ece": 0.05}}
        self.assertTrue(gate.decide(cand, inc)["promote"])


if __name__ == "__main__":
    unittest.main()
