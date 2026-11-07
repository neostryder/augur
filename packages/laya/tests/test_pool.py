import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from pool import Pool, PoolError, load_config, servers_from_config, sync_targets  # noqa: E402


def serve(load=None, post=(200, {"ok": True})):
    """A stand-in Laya server. `load` is the /load body (or None for a 404), `post` the status and body of /v1/systemone."""
    hits = {"load": 0, "post": 0}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            hits["load"] += 1
            self._send(200, load) if load is not None else self._send(404, {})

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            hits["post"] += 1
            self._send(*post)

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, hits, f"http://127.0.0.1:{srv.server_address[1]}"


class PoolTests(unittest.TestCase):
    def setUp(self):
        self.stops = []
        self.now = [0.0]

    def tearDown(self):
        for s in self.stops:
            s.shutdown()

    def s(self, **kw):
        srv, hits, url = serve(**kw)
        self.stops.append(srv)
        return hits, url

    def pool(self, *urls):
        return Pool([{"name": f"s{i}", "url": u} for i, u in enumerate(urls)], clock=lambda: self.now[0])

    def test_uses_the_first_server_when_it_is_healthy(self):
        h1, u1 = self.s(load={"busy": False, "ready": True})
        h2, u2 = self.s(load={"busy": False, "ready": True})
        out, name = self.pool(u1, u2).post("/v1/systemone", {})
        self.assertEqual((out, name), ({"ok": True}, "s0"))
        self.assertEqual(h2["post"], 0)

    def test_skips_a_busy_server_and_remembers_it_for_a_few_seconds(self):
        h1, u1 = self.s(load={"busy": True, "reasons": ["GPU use over 80%"], "ready": True})
        h2, u2 = self.s(load={"busy": False, "ready": True})
        p = self.pool(u1, u2)
        self.assertEqual(p.post("/v1/systemone", {})[1], "s1")
        p.post("/v1/systemone", {})
        self.assertEqual(h1["load"], 1)   # not asked again inside the window
        self.now[0] = 6.0
        p.post("/v1/systemone", {})
        self.assertEqual(h1["load"], 2)

    def test_skips_an_unreachable_server_for_half_a_minute(self):
        h2, u2 = self.s(load=None)
        p = self.pool("http://127.0.0.1:9", u2)
        self.assertEqual(p.post("/v1/systemone", {})[1], "s1")
        self.assertIn("unreachable", p._skip["http://127.0.0.1:9"][1])
        self.assertGreater(p._skip["http://127.0.0.1:9"][0], 29)

    def test_a_503_from_the_call_itself_moves_on(self):
        h1, u1 = self.s(load=None, post=(503, {"error": "busy"}))
        h2, u2 = self.s(load=None)
        self.assertEqual(self.pool(u1, u2).post("/v1/systemone", {})[1], "s1")

    def test_a_client_error_is_raised_and_not_retried(self):
        h1, u1 = self.s(load=None, post=(422, {"error": "bad"}))
        h2, u2 = self.s(load=None)
        with self.assertRaises(urllib.error.HTTPError):
            self.pool(u1, u2).post("/v1/systemone", {})
        self.assertEqual(h2["post"], 0)

    def test_reports_every_reason_when_nothing_answers(self):
        h1, u1 = self.s(load={"busy": True, "reasons": ["video memory over 80%"], "ready": True})
        with self.assertRaises(PoolError) as cm:
            self.pool(u1, "http://127.0.0.1:9").post("/v1/systemone", {})
        self.assertIn("video memory over 80%", cm.exception.reasons["s0"])
        self.assertIn("unreachable", cm.exception.reasons["s1"])

    def test_a_server_that_is_not_ready_is_skipped(self):
        h1, u1 = self.s(load={"busy": False, "ready": False})
        h2, u2 = self.s(load={"busy": False, "ready": True})
        self.assertEqual(self.pool(u1, u2).post("/v1/systemone", {})[1], "s1")

    def test_a_no_rows_mirror_linked_by_name_is_checked_and_takes_over(self):
        busy_hits, busy_url = self.s(load={"busy": True, "reasons": ["GPU use over 80%"], "ready": True})
        ok_hits, ok_url = self.s(load={"busy": False, "ready": True})
        data = {
            "servers": [{"name": "eru", "url": busy_url}, {"name": "bazzite", "url": ok_url}],
            "syncHosts": [{"host": "aaron@bazzite", "rows": False}],
        }
        servers = servers_from_config(data, {})
        self.assertEqual([(s["name"], s["url"]) for s in servers], [("eru", busy_url), ("bazzite", ok_url)])
        pool = Pool(servers, clock=lambda: self.now[0])
        report = pool.health()
        self.assertIsNone(report["bazzite"])
        self.assertIn("busy", report["eru"])
        out, name = pool.post("/v1/systemone", {})
        self.assertEqual((out, name), ({"ok": True}, "bazzite"))
        self.assertEqual(ok_hits["post"], 1)
        self.assertEqual(busy_hits["post"], 0)


class ConfigTests(unittest.TestCase):
    def test_sync_host_alone_is_one_host_with_rows(self):
        self.assertEqual(
            sync_targets({"syncHost": "aaron@bilbo", "repo": "D:/Repositories/augur"}, {}),
            [{"host": "aaron@bilbo", "rows": True, "name": "bilbo"}],
        )

    def test_sync_hosts_list_defaults_rows_to_true_and_skips_bad_entries(self):
        cfg = {
            "syncHost": "aaron@bilbo",
            "syncHosts": [
                "aaron@bilbo",
                {"host": "aaron@bazzite", "rows": False},
                {"host": "aaron@other"},
                {"host": "aaron@typo", "rows": "no"},
                "",
                {"host": ""},
                3,
            ],
        }
        self.assertEqual(sync_targets(cfg, {}), [
            {"host": "aaron@bilbo", "rows": True, "name": "bilbo"},
            {"host": "aaron@bazzite", "rows": False, "name": "bazzite"},
            {"host": "aaron@other", "rows": True, "name": "other"},
            {"host": "aaron@typo", "rows": True, "name": "typo"},
        ])

    def test_laya_bilbo_replaces_sync_hosts_with_one_host_that_has_rows(self):
        cfg = {"syncHosts": [{"host": "aaron@bazzite", "rows": False}]}
        self.assertEqual(
            sync_targets(cfg, {"LAYA_BILBO": "aaron@bilbo"}),
            [{"host": "aaron@bilbo", "rows": True, "name": "bilbo"}],
        )

    def test_a_host_without_a_user_uses_the_whole_string_as_its_name(self):
        self.assertEqual(sync_targets({"syncHosts": ["bazzite"]}, {}), [{"host": "bazzite", "rows": True, "name": "bazzite"}])

    def test_load_config_returns_sync_hosts_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "laya.json")
            payload = {"syncHost": "aaron@bilbo", "syncHosts": [{"host": "aaron@bazzite", "rows": False}]}
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                json.dump(payload, f)
            self.assertEqual(load_config(path), payload)
            self.assertEqual(load_config(os.path.join(folder, "missing.json")), {})

    def test_a_sync_host_without_a_server_entry_is_still_in_the_pool(self):
        data = {
            "servers": [{"name": "eru", "url": "http://127.0.0.1:8010"}],
            "syncHost": "aaron@bilbo",
            "syncHosts": [{"host": "aaron@bazzite", "rows": False}],
        }
        self.assertEqual(servers_from_config(data, {}), [
            {"name": "eru", "url": "http://127.0.0.1:8010"},
            {"name": "bilbo", "url": "http://bilbo:8010"},
            {"name": "bazzite", "url": "http://bazzite:8010"},
        ])

    def test_a_sync_host_that_matches_a_server_name_is_not_listed_twice(self):
        data = {
            "servers": [{"name": "bazzite", "url": "http://192.168.2.60:8010"}],
            "syncHosts": [{"host": "aaron@bazzite", "rows": False}],
        }
        self.assertEqual(servers_from_config(data, {}), [{"name": "bazzite", "url": "http://192.168.2.60:8010"}])

    def test_the_live_config_keeps_exactly_three_servers(self):
        data = {
            "servers": [
                {"name": "eru", "url": "http://127.0.0.1:8010"},
                {"name": "bilbo", "url": "http://192.168.2.154:8010"},
                {"name": "bazzite", "url": "http://192.168.2.60:8010"},
            ],
            "syncHost": "strider@192.168.2.154",
        }
        servers = servers_from_config(data, {})
        self.assertEqual(len(servers), 3)
        self.assertEqual(servers, data["servers"])

    def test_an_ip_sync_host_matches_a_server_url_host(self):
        data = {
            "servers": [{"name": "bilbo", "url": "http://192.168.2.154"}],
            "syncHost": "strider@192.168.2.154",
        }
        self.assertEqual(servers_from_config(data, {}), data["servers"])

    def test_sync_targets_keeps_an_explicit_server_name(self):
        data = {"syncHosts": [{"host": "strider@ssh-alias", "rows": False, "server": " bilbo "}]}
        self.assertEqual(sync_targets(data, {}), [
            {"host": "strider@ssh-alias", "rows": False, "name": "ssh-alias", "server": "bilbo"},
        ])

    def test_an_explicit_server_name_links_an_unmatched_ssh_alias(self):
        data = {
            "servers": [{"name": "bilbo", "url": "http://192.168.2.154:8010"}],
            "syncHosts": [{"host": "strider@ssh-alias", "rows": False, "server": "bilbo"}],
        }
        self.assertEqual(servers_from_config(data, {}), data["servers"])

    def test_an_unknown_or_invalid_server_key_falls_back_to_hostname_matching(self):
        for server in ("missing", "", None, 3, ["bilbo"]):
            with self.subTest(server=server):
                data = {
                    "servers": [{"name": "bilbo", "url": "http://192.168.2.154:8010"}],
                    "syncHosts": [{"host": "strider@192.168.2.154", "server": server}],
                }
                self.assertEqual(servers_from_config(data, {}), data["servers"])
                data["syncHosts"][0]["host"] = "strider@other"
                self.assertEqual(servers_from_config(data, {}), data["servers"] + [
                    {"name": "other", "url": "http://other:8010"},
                ])

    def test_hostname_matching_ignores_case_for_names_and_urls(self):
        for name, url, host in (
            ("BaZzItE", "http://192.168.2.60:8010", "bazzite"),
            ("mirror", "http://BaZzItE:8010", "BAZZITE"),
        ):
            with self.subTest(name=name, url=url, host=host):
                data = {"servers": [{"name": name, "url": url}], "syncHosts": [f"strider@{host}"]}
                self.assertEqual(servers_from_config(data, {}), data["servers"])

    def test_url_host_matching_ignores_scheme_port_and_path(self):
        for url in ("http://bilbo:8020", "https://bilbo/api", "https://bilbo:9443/api/v1"):
            with self.subTest(url=url):
                data = {"servers": [{"name": "mirror", "url": url}], "syncHost": "strider@bilbo"}
                self.assertEqual(servers_from_config(data, {}), data["servers"])

    def test_a_malformed_server_url_does_not_prevent_appending_an_unmatched_host(self):
        data = {"servers": [{"name": "broken", "url": "http://["}], "syncHost": "strider@bilbo"}
        self.assertEqual(servers_from_config(data, {}), [
            {"name": "broken", "url": "http://["},
            {"name": "bilbo", "url": "http://bilbo:8010"},
        ])

    def test_missing_servers_keeps_the_local_default_and_adds_the_sync_host(self):
        servers = servers_from_config({"syncHost": "aaron@bilbo"}, {})
        self.assertEqual(servers, [
            {"name": "local", "url": "http://127.0.0.1:8010"},
            {"name": "bilbo", "url": "http://bilbo:8010"},
        ])

    def test_from_config_reads_the_file_and_the_passed_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "laya.json")
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                json.dump({"servers": [{"name": "eru", "url": "http://127.0.0.1:8010"}], "syncHosts": ["aaron@bilbo"]}, f)
            pool = Pool.from_config(path, env={})
        self.assertEqual([s["name"] for s in pool.servers], ["eru", "bilbo"])


if __name__ == "__main__":
    unittest.main()
