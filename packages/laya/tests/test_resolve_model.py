import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))


def stand_ins():
    """laya.serve with no checkpoints, for a machine that does not have the stock package."""
    if "laya.serve" not in sys.modules:
        laya = types.ModuleType("laya")
        serve = types.ModuleType("laya.serve")
        common = types.ModuleType("laya.common")
        serve.MAX_STATE_CHARS = 50000

        def stock(model, *rest):
            return model

        serve._resolve_model = stock
        common.QTYPES = {}
        laya.serve = serve
        laya.common = common
        sys.modules["laya"] = laya
        sys.modules["laya.serve"] = serve
        sys.modules["laya.common"] = common
    sys.modules.setdefault("lora", types.ModuleType("lora"))
    if "ctxutil" not in sys.modules:
        ctx = types.ModuleType("ctxutil")
        ctx.LONG_CONTEXT = 1024
        sys.modules["ctxutil"] = ctx


try:
    import serve_lora  # noqa: E402
except ImportError:   # the stock laya package is only on the service's own Python
    sys.modules.pop("serve_lora", None)
    stand_ins()
    import serve_lora  # noqa: E402


class ResolveShimTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.previous = serve_lora._stock_resolve

        def record(model, *rest):
            self.calls.append((model, rest))
            return "from-stock"

        serve_lora._stock_resolve = record

    def tearDown(self):
        serve_lora._stock_resolve = self.previous

    def test_a_laya_name_is_unchanged_with_one_or_two_arguments(self):
        resolve = object()
        self.assertIs(serve_lora.S._resolve_model, serve_lora._resolve_model)
        self.assertEqual(serve_lora.S._resolve_model("laya:pilot"), "laya:pilot")
        self.assertEqual(serve_lora.S._resolve_model("laya:@adapter", resolve), "laya:@adapter")
        self.assertEqual(self.calls, [])

    def test_another_name_is_forwarded_with_every_extra_argument(self):
        resolve = object()
        self.assertEqual(serve_lora.S._resolve_model("english"), "from-stock")
        self.assertEqual(serve_lora.S._resolve_model("english", resolve, "tail"), "from-stock")
        self.assertEqual(self.calls, [("english", ()), ("english", (resolve, "tail"))])


if __name__ == "__main__":
    unittest.main()
