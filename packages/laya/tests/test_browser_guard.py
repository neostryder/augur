import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import browser_guard as g  # noqa: E402


class BrowserGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "adapters")
        os.makedirs(os.path.join(self.root, "priv_one"))
        os.makedirs(os.path.join(self.root, "plain"))
        self.registry = os.path.join(self.root, "registry.json")
        with open(self.registry, "w", encoding="utf-8") as f:
            json.dump({"browser_blocked_prefixes": ["priv_"], "pilots": {"safe": {"adapter": "plain"}, "sneaky": {"adapter": "priv_one"}, "priv_pilot": {"adapter": "plain"}, "bad": {"adapter": "../x"}}}, f)

    def tearDown(self):
        self.tmp.cleanup()

    def allowed(self, model):
        return g.browser_may_use(model, self.registry)[0]

    def test_plain_requests_and_safe_pilots_pass(self):
        self.assertTrue(self.allowed("english"))
        self.assertTrue(self.allowed(None))
        self.assertTrue(self.allowed("laya:safe"))
        self.assertTrue(self.allowed("laya:@plain"))

    def test_priv_is_blocked_by_every_spelling(self):
        for model in ["laya:priv_pilot", "laya:@priv_one", "laya:@PRIV_one", "laya:PRIV_pilot", "laya:@./priv_one", "laya:@x/../priv_one",
                      "laya:@..", "laya:@", "laya:@a/b", "laya:@.hidden", "laya:@priv_one/", "laya:@a\b", "laya:sneaky", "laya:bad"]:
            self.assertFalse(self.allowed(model), model)

    def test_adapter_folders_stay_inside_the_adapters_folder(self):
        self.assertEqual(g.adapter_dir(self.root, "plain"), os.path.join(self.root, "plain"))
        for name in ["../plain", "plain/..", ".", "..", "a/b", ""]:
            with self.assertRaises(ValueError):
                g.adapter_dir(self.root, name)

    def test_an_unreadable_registry_blocks_pilot_requests(self):
        with open(self.registry, "w", encoding="utf-8") as f:
            f.write("{ not json")
        self.assertFalse(self.allowed("laya:safe"))
        self.assertTrue(self.allowed("english"))

    def test_the_environment_can_add_a_blocked_prefix(self):
        os.environ["LAYA_BROWSER_BLOCKED_PREFIXES"] = "extra_"
        try:
            self.assertFalse(self.allowed("laya:@extra_one"))
        finally:
            del os.environ["LAYA_BROWSER_BLOCKED_PREFIXES"]

    def test_oversized_bodies_are_refused(self):
        self.assertFalse(g.body_too_large("100"))
        self.assertTrue(g.body_too_large(str(g.MAX_BROWSER_BODY + 1)))
        self.assertTrue(g.body_too_large(None, g.MAX_BROWSER_BODY + 1))
        self.assertTrue(g.body_too_large("abc"))


if __name__ == "__main__":
    unittest.main()
