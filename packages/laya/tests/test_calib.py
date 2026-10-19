import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import calib  # noqa: E402

QTYPES = {"choice": 0, "score": 1, "noul": 2}


class Temperatures(unittest.TestCase):
    def test_clamp_keeps_a_fitted_value_in_range(self):
        self.assertEqual(calib.clamp_temperature(5.3262), 5.0)
        self.assertEqual(calib.clamp_temperature(0.1), 0.5)
        self.assertEqual(calib.clamp_temperature(1.7), 1.7)

    def test_clamp_refuses_junk(self):
        for junk in (None, "x", True, float("nan"), float("inf")):
            self.assertEqual(calib.clamp_temperature(junk), 1.0)

    def test_manifest_temperatures(self):
        self.assertEqual(calib.manifest_temperatures({"temperature_by_type": {"choice": 5.3262, "score": 1.4}}),
                         {"choice": 5.0, "score": 1.4})
        self.assertEqual(calib.manifest_temperatures({}), {})
        self.assertEqual(calib.manifest_temperatures(None), {})

    def test_fitted_type_replaces_its_buckets_only(self):
        base = [1.2, 1.1, 1.0]
        buckets = {"choice:2": 1.3, "choice:3-5": 1.4, "score:3-5": 1.5}
        temperature, by_options = calib.apply_temperatures(base, buckets, {"choice": 2.5}, QTYPES)
        self.assertEqual(temperature, [2.5, 1.1, 1.0])
        self.assertEqual(by_options, {"score:3-5": 1.5})
        self.assertEqual(base, [1.2, 1.1, 1.0])      # inputs are not changed
        self.assertEqual(len(buckets), 3)

    def test_no_fit_restores_the_base(self):
        base, buckets = [1.2, 1.1, 1.0], {"choice:2": 1.3}
        self.assertEqual(calib.apply_temperatures(base, buckets, {}, QTYPES), (base, buckets))

    def test_unknown_type_is_ignored(self):
        self.assertEqual(calib.apply_temperatures([1, 1, 1], {}, {"mystery": 2.0}, QTYPES), ([1, 1, 1], {}))


class Sigma(unittest.TestCase):
    def test_anneals_from_start_to_end(self):
        self.assertAlmostEqual(calib.sigma_at(0, 100), 0.4)
        self.assertAlmostEqual(calib.sigma_at(50, 100), 0.25)
        self.assertAlmostEqual(calib.sigma_at(100, 100), 0.1)
        self.assertAlmostEqual(calib.sigma_at(500, 100), 0.1)
        self.assertAlmostEqual(calib.sigma_at(5, 0), 0.4)


class Collapse(unittest.TestCase):
    def test_constant_logits_warn(self):
        rows = [("choice", [0.0, 0.0, 0.0, 0.0], [1, 0, 0, 0])] * 5
        stats = calib.collapse_stats(rows)
        self.assertAlmostEqual(stats["mean_ce"], math.log(4))
        self.assertIn("collapsed", calib.collapse_message(stats))

    def test_learning_head_is_quiet(self):
        rows = [("choice", [3.0, 0.0, -1.0, 0.5], [1, 0, 0, 0])] * 5
        self.assertIsNone(calib.collapse_message(calib.collapse_stats(rows)))

    def test_one_option_rows_are_skipped(self):
        self.assertIsNone(calib.collapse_stats([("choice", [1.0], [1.0])]))
        self.assertIsNone(calib.collapse_message(None))


class LabelTag(unittest.TestCase):
    def test_tags_spell_the_answers(self):
        row = {"state": "x", "labels": {"goal": "stairs"}, "soft": {"gate": 0.8, "move": {"a": 0.2, "b": 0.7}}}
        self.assertEqual(calib.label_tag(row), "label[goal]=stairs; label[gate]=true; label[move]=b; ")

    def test_state_shapes_keep_the_tag_where_truncation_spares_it(self):
        row = {"labels": {"q": "a"}}
        self.assertEqual(calib.tag_state(dict(row, state="body")), "label[q]=a; body")
        self.assertEqual(calib.tag_state(dict(row, state={"k": 1})), {"label_tag": "label[q]=a;", "k": 1})
        self.assertEqual(calib.tag_state(dict(row, state=["t1", "t2"])), ["t1", "t2", "label[q]=a;"])

    def test_row_without_answers_is_unchanged(self):
        self.assertEqual(calib.tag_state({"state": "body"}), "body")


try:
    import torch  # noqa: F401
except ImportError:
    torch = None


@unittest.skipIf(torch is None, "needs torch")
class Fit(unittest.TestCase):
    def test_types_under_the_floor_are_not_fitted(self):
        import torch as t
        import types
        sys.modules.setdefault("lora", types.ModuleType("lora"))
        # fit_temperatures lives in train.py, which imports laya; load only the function's source
        import ast
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "train.py"), encoding="utf-8").read()
        node = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == "fit_temperatures")
        ns = {"torch": t, "calib": calib}
        exec(compile(ast.Module([node], []), "train.py", "exec"), ns)
        z = [t.tensor([2.0, 0.0, 0.0])] * 60
        tgt = [[1.0, 0.0, 0.0]] * 60
        rows = [("choice", zi, ti) for zi, ti in zip(z, tgt)] + [("score", t.tensor([1.0, 0.0]), [1.0, 0.0])] * 10
        temps, counts = ns["fit_temperatures"](rows)
        self.assertEqual(counts, {"choice": 60, "score": 10})
        self.assertIn("choice", temps)
        self.assertNotIn("score", temps)
        self.assertTrue(calib.TEMP_MIN <= temps["choice"] <= calib.TEMP_MAX)


if __name__ == "__main__":
    unittest.main()
