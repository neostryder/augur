import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

try:
    import serve_lora
except ImportError:   # the stock laya package is only on the service's own Python
    serve_lora = None


class FakeRouter:
    def __init__(self):
        self.loads, self.unloads = [], 0

    def load(self, name):
        self.loads.append(name)
        raise RuntimeError("stop after the load is asked for")

    def unload(self):
        self.unloads += 1


@unittest.skipIf(serve_lora is None, "laya is not installed")
class ServingLazy(unittest.TestCase):
    def test_nothing_loads_until_the_first_request(self):
        router = FakeRouter()
        serving = serve_lora.Serving(router)
        self.assertEqual(router.loads, [])
        self.assertTrue(serving.unloaded)
        serving.unload()
        self.assertEqual(router.unloads, 0)
        with self.assertRaises(RuntimeError):
            serving.ensure()
        self.assertEqual(router.loads, ["english"])


if __name__ == "__main__":
    unittest.main()
