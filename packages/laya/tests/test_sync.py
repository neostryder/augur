import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import sync  # noqa: E402


def write_adapter(root, name, payload=b"weights"):
    folder = os.path.join(root, "adapters", name)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("{}\n")
    with open(os.path.join(folder, "adapter.safetensors"), "wb") as handle:
        handle.write(payload)


def write_registry(root, pilots, history=None):
    folder = os.path.join(root, "adapters")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "registry.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump({"pilots": pilots, "history": history or []}, handle)


def write_row(root, name, text):
    folder = os.path.join(root, "data")
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, name), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


class Remote:
    """Stand-in for ssh and scp. One host can be down, or can lie about a checksum."""

    def __init__(self):
        self.hosts = {}
        self.calls = []

    def state(self, host):
        return self.hosts.setdefault(host, {
            "down": False,
            "bad_sha": False,
            "adapters": {},
            "registry": {"pilots": {}, "history": []},
            "rows": {},
            "events": [],
        })

    def run(self, cmd, **kwargs):
        if kwargs.get("creationflags", None) != sync.FLAGS:
            raise AssertionError(f"missing no-window flag: {kwargs.get('creationflags')!r}")
        self.calls.append(list(cmd))
        if cmd[0] == "ssh":
            if cmd[:3] != ["ssh", "-o", "BatchMode=yes"]:
                raise AssertionError(cmd)
            return self._ssh(cmd)
        if cmd[0] == "scp":
            if cmd[:4] != ["scp", "-q", "-o", "BatchMode=yes"]:
                raise AssertionError(cmd)
            return self._scp(cmd)
        return subprocess.CompletedProcess(cmd, 1, "", f"unexpected {cmd[0]}")

    def _ssh(self, cmd):
        host, command = cmd[3], cmd[4]
        st = self.state(host)
        if st["down"]:
            st["events"].append("down")
            return subprocess.CompletedProcess(cmd, 255, "", "ssh: connect to host port 22: Connection refused")
        root = "laya-serve"
        if command.startswith(f"cd {root}/adapters"):
            st["events"].append("list-adapters")
            lines = [f"{name} {sha}" for name, sha in sorted(st["adapters"].items())]
            return subprocess.CompletedProcess(cmd, 0, ("\n".join(lines) + "\n") if lines else "", "")
        if command.startswith(f"cat {root}/adapters/registry.json"):
            st["events"].append("read-registry")
            return subprocess.CompletedProcess(cmd, 0, json.dumps(st["registry"]), "")
        if command.startswith(f"cd {root}/data"):
            st["events"].append("list-rows")
            lines = [f"{name} {sha}" for name, sha in sorted(st["rows"].items())]
            return subprocess.CompletedProcess(cmd, 0, ("\n".join(lines) + "\n") if lines else "", "")
        if command.startswith("shasum "):
            st["events"].append("checksum")
            name = command.split("/adapters/")[1].split("/")[0]
            sha = "0" * 64 if st["bad_sha"] else st["adapters"].get(name, "")
            return subprocess.CompletedProcess(cmd, 0, sha + "\n", "")
        if command.startswith("mv "):
            st["events"].append("registry-renamed")
            st["registry"] = json.loads(json.dumps(st.get("incoming") or {}))
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return subprocess.CompletedProcess(cmd, 1, "", f"unexpected ssh: {command}")

    def _is_remote(self, arg):
        return ":" in arg and not (len(arg) > 2 and arg[1] == ":" and arg[0].isalpha())

    def _scp(self, cmd):
        args = cmd[4:]
        if args and args[0] == "-r":
            src, dest = args[1], args[2]
            if self._is_remote(src):
                host, path = src.split(":", 1)
                name = path.rstrip("/").split("/")[-1]
                st = self.state(host)
                st["events"].append("scp-adapter-from")
                folder = os.path.join(dest, name)
                os.makedirs(folder, exist_ok=True)
                with open(os.path.join(folder, "manifest.json"), "w", encoding="utf-8", newline="\n") as handle:
                    handle.write("{}\n")
                with open(os.path.join(folder, "adapter.safetensors"), "wb") as handle:
                    handle.write(b"remote-weights")
                return subprocess.CompletedProcess(cmd, 0, "", "")
            host = dest.split(":", 1)[0]
            st = self.state(host)
            if st["down"]:
                st["events"].append("down")
                return subprocess.CompletedProcess(cmd, 1, "", "lost connection")
            name = os.path.basename(src.rstrip("\\/"))
            st["adapters"][name] = sync.sha256(os.path.join(src, "adapter.safetensors"))
            st["events"].append("scp-adapter")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        src, dest = args[0], args[1]
        if self._is_remote(src):
            host, path = src.split(":", 1)
            st = self.state(host)
            name = path.rstrip("/").split("/")[-1]
            st["events"].append("scp-from")
            with open(dest, "wb") as handle:
                handle.write(st.get("bodies", {}).get(name, b"{}\n"))
            return subprocess.CompletedProcess(cmd, 0, "", "")
        host, path = dest.split(":", 1)
        st = self.state(host)
        if st["down"]:
            st["events"].append("down")
            return subprocess.CompletedProcess(cmd, 1, "", "lost connection")
        if path.endswith("registry.json.incoming"):
            with open(src, encoding="utf-8") as handle:
                st["incoming"] = json.load(handle)
            st["events"].append("scp-registry-incoming")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if "/data/" in path:
            st["rows"][path.rstrip("/").split("/")[-1]] = "copied"
            st["events"].append("scp-row")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return subprocess.CompletedProcess(cmd, 1, "", f"unexpected scp {args}")


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        self.remote = Remote()
        self.env = patch.dict(os.environ, {"LAYA_HOME": self.home})
        self.env.start()
        self.run = patch("sync.subprocess.run", side_effect=self.remote.run)
        self.run.start()
        write_adapter(self.home, "fit-1", b"weights-v1")
        write_registry(self.home, {"augur_fit": {"adapter": "fit-1"}})
        write_row(self.home, "decisions.jsonl", '{"a": 1}\n')

    def tearDown(self):
        self.run.stop()
        self.env.stop()
        self.tmp.cleanup()

    def run_main(self, argv, config):
        out, err = io.StringIO(), io.StringIO()
        with patch("pool.load_config", return_value=config), patch("sys.stdout", out), patch("sys.stderr", err):
            try:
                sync.main(argv)
                code = 0
            except SystemExit as exc:
                code = exc.code if exc.code is not None else 0
        text = out.getvalue()
        parsed = json.loads(text) if text.strip().startswith("{") else None
        return code, parsed, err.getvalue(), text

    def test_sync_host_alone_still_pushes_rows(self):
        code, parsed, err, _ = self.run_main(["push"], {"syncHost": "aaron@bilbo"})
        self.assertEqual(code, 0, err)
        self.assertEqual([h["host"] for h in parsed["hosts"]], ["aaron@bilbo"])
        self.assertTrue(parsed["hosts"][0]["copy_rows"])
        self.assertEqual(parsed["hosts"][0]["rows"]["to_remote"], ["decisions.jsonl"])
        events = self.remote.state("aaron@bilbo")["events"]
        self.assertEqual(events, [
            "list-adapters", "read-registry", "list-rows",
            "scp-adapter", "checksum", "scp-row", "scp-registry-incoming", "registry-renamed",
        ])
        self.assertEqual(self.remote.state("aaron@bilbo")["registry"]["pilots"], {"augur_fit": {"adapter": "fit-1"}})
        self.assertIn("decisions.jsonl", self.remote.state("aaron@bilbo")["rows"])

    def test_one_host_down_does_not_stop_the_other_or_rename_its_registry(self):
        self.remote.state("aaron@bilbo")["down"] = True
        config = {"syncHost": "aaron@bilbo", "syncHosts": [{"host": "aaron@bazzite", "rows": False}]}
        code, parsed, err, _ = self.run_main(["push"], config)
        self.assertEqual(code, 1)
        self.assertIn("aaron@bilbo", err)
        by_host = {item["host"]: item for item in parsed["hosts"]}
        self.assertFalse(by_host["aaron@bilbo"]["ok"])
        self.assertTrue(by_host["aaron@bazzite"]["ok"])
        self.assertFalse(by_host["aaron@bazzite"]["copy_rows"])
        self.assertEqual(by_host["aaron@bazzite"]["rows"]["to_remote"], [])
        self.assertEqual(self.remote.state("aaron@bilbo")["events"], ["down"])
        self.assertNotIn("registry-renamed", self.remote.state("aaron@bilbo")["events"])
        self.assertEqual(self.remote.state("aaron@bazzite")["events"], [
            "list-adapters", "read-registry", "scp-adapter", "checksum", "scp-registry-incoming", "registry-renamed",
        ])
        self.assertNotIn("scp-row", self.remote.state("aaron@bazzite")["events"])
        self.assertNotIn("list-rows", self.remote.state("aaron@bazzite")["events"])
        self.assertEqual(self.remote.state("aaron@bazzite")["rows"], {})

    def test_a_checksum_mismatch_does_not_rename_that_registry(self):
        self.remote.state("aaron@bazzite")["bad_sha"] = True
        config = {"syncHost": "aaron@bilbo", "syncHosts": [{"host": "aaron@bazzite", "rows": False}]}
        code, parsed, _, _ = self.run_main(["push"], config)
        self.assertEqual(code, 1)
        by_host = {item["host"]: item for item in parsed["hosts"]}
        self.assertTrue(by_host["aaron@bilbo"]["ok"])
        self.assertFalse(by_host["aaron@bazzite"]["ok"])
        self.assertIn("checksum mismatch", by_host["aaron@bazzite"]["error"])
        self.assertIn("registry-renamed", self.remote.state("aaron@bilbo")["events"])
        bazzite = self.remote.state("aaron@bazzite")["events"]
        self.assertIn("checksum", bazzite)
        self.assertNotIn("scp-registry-incoming", bazzite)
        self.assertNotIn("registry-renamed", bazzite)
        self.assertEqual(self.remote.state("aaron@bazzite")["registry"], {"pilots": {}, "history": []})

    def test_status_reports_each_host_when_one_is_down(self):
        self.remote.state("aaron@bilbo")["down"] = True
        config = {"syncHosts": ["aaron@bilbo", {"host": "aaron@bazzite", "rows": False}]}
        code, parsed, err, _ = self.run_main(["status"], config)
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual([item["host"] for item in parsed["hosts"]], ["aaron@bilbo", "aaron@bazzite"])
        self.assertFalse(parsed["hosts"][0]["ok"])
        self.assertTrue(parsed["hosts"][1]["ok"])
        self.assertEqual(parsed["hosts"][1]["adapters_to_remote"], ["fit-1"])
        self.assertFalse(parsed["hosts"][1]["copy_rows"])
        self.assertNotIn("registry-renamed", self.remote.state("aaron@bazzite")["events"])

    def test_host_filter_contacts_only_the_named_host(self):
        config = {"syncHost": "aaron@bilbo", "syncHosts": [{"host": "aaron@bazzite", "rows": False}]}
        code, parsed, err, _ = self.run_main(["push", "--host", "bazzite"], config)
        self.assertEqual(code, 0, err)
        self.assertEqual([item["host"] for item in parsed["hosts"]], ["aaron@bazzite"])
        self.assertNotIn("aaron@bilbo", self.remote.hosts)
        self.assertNotIn("scp-row", self.remote.state("aaron@bazzite")["events"])

    def test_pull_reads_only_the_first_host_that_keeps_rows(self):
        bilbo = self.remote.state("aaron@bilbo")
        bilbo["adapters"]["from-bilbo"] = "abc"
        bilbo["rows"]["extra.jsonl"] = "deadbeef"
        bilbo["registry"] = {
            "pilots": {"augur_fit": {"adapter": "other"}, "only_there": {"adapter": "x"}},
            "history": [{"ts": "2026-11-07", "pilot": "p"}],
        }
        config = {"syncHosts": [{"host": "aaron@bazzite", "rows": False}, "aaron@bilbo"]}
        code, parsed, err, _ = self.run_main(["pull"], config)
        self.assertEqual(code, 0, err)
        self.assertEqual([item["host"] for item in parsed["hosts"]], ["aaron@bilbo"])
        self.assertNotIn("aaron@bazzite", self.remote.hosts)
        self.assertIn("scp-adapter-from", bilbo["events"])
        self.assertTrue(os.path.isfile(os.path.join(self.home, "adapters", "from-bilbo", "manifest.json")))
        with open(os.path.join(self.home, "adapters", "registry.json"), encoding="utf-8") as handle:
            saved = json.load(handle)
        self.assertEqual(saved["pilots"]["augur_fit"], {"adapter": "fit-1"})
        self.assertEqual(saved["pilots"]["only_there"], {"adapter": "x"})
        self.assertEqual(saved["history"], [{"ts": "2026-11-07", "pilot": "p"}])

    def test_push_with_no_host_names_sync_hosts_in_the_message(self):
        code, parsed, _, _ = self.run_main(["push"], {})
        self.assertIsNone(parsed)
        self.assertIn("syncHosts", str(code))
        self.assertEqual(self.remote.calls, [])


if __name__ == "__main__":
    unittest.main()
