import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from uuid import uuid4

ROOT = Path(__file__).parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


client_module = load("yer_test_client", ROOT / "dashboard" / "yer_client.py")
YerClient, YerError = client_module.YerClient, client_module.YerError


class FixtureServer:
    def __init__(self):
        self.source_id = str(uuid4())
        self.redirect = False
        self.wrong_identity = False
        self.calls = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.calls.append(("GET", self.path))
                if self.path == "/engineering/identity":
                    value = {"service": "yuki-engineering-runtime", "protocol_version": 1,
                             "source_id": str(uuid4()) if owner.wrong_identity else owner.source_id}
                elif owner.redirect:
                    self.send_response(302)
                    self.send_header("Location", "http://unreachable.invalid/")
                    self.end_headers()
                    return
                else:
                    value = {"source_id": owner.source_id, "tickets": [], "events": [],
                             "next_cursor": 0, "high_water_cursor": 0, "has_more": False}
                self.reply(value)

            def do_POST(self):
                owner.calls.append(("POST", self.path))
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.reply({"source_id": owner.source_id, "receipt": {"operation_id": "fixture-operation"},
                            "request": payload})

            def reply(self, value):
                encoded = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class ClientTests(unittest.TestCase):
    def test_rejects_external_alias_redirect_and_wrong_identity(self):
        for endpoint in ("http://localhost:1", "https://127.0.0.1:1", "http://127.0.0.1:1/path",
                         "http://user@127.0.0.1:1", "http://127.0.0.1:bad", "http://example.invalid:1"):
            with self.assertRaises(YerError, msg=endpoint):
                YerClient(endpoint, str(uuid4()))
        server = FixtureServer()
        self.addCleanup(server.close)
        client = YerClient(server.endpoint, server.source_id)
        server.redirect = True
        with self.assertRaisesRegex(YerError, "REDIRECT_REFUSED"):
            client.request("GET", "/engineering/tickets")
        server.wrong_identity = True
        previous = len(server.calls)
        with self.assertRaisesRegex(YerError, "YER_IDENTITY_MISMATCH"):
            client.request("GET", "/engineering/tickets")
        self.assertEqual(server.calls[previous:], [("GET", "/engineering/identity")])

    def test_direct_connection_ignores_proxy_environment(self):
        server = FixtureServer()
        self.addCleanup(server.close)
        with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1",
                                     "HTTPS_PROXY": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1"}):
            os.environ.pop("NO_PROXY", None)
            result = YerClient(server.endpoint, server.source_id).request("GET", "/engineering/tickets")
            self.assertEqual(result["source_id"], server.source_id)

    def test_failed_post_is_unknown_and_never_replayed(self):
        server = FixtureServer()
        endpoint, source = server.endpoint, server.source_id
        server.close()
        # Exercise the actual post transport failure after a successful identity
        # precondition was lost, rather than treating this as a successful action.
        with self.assertRaises(YerError) as result:
            YerClient(endpoint, source, "fixture-token", timeout=0.1)._request(
                "POST", "/engineering/tickets/fixture/confirm", {}, control=True)
        self.assertTrue(result.exception.reconciliation_required)
        self.assertFalse(result.exception.retryable)


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi import HTTPException
        import asyncio
        cls.home = tempfile.TemporaryDirectory(prefix="yer-plugin-test-")
        constants = types.ModuleType("hermes_constants")
        constants.get_hermes_home = lambda: Path(cls.home.name)
        host = types.ModuleType("hermes_cli.web_server")

        def require_token(request):
            if request.headers.get("authorization") != "Bearer fixture-host-token":
                raise HTTPException(401, "Unauthorized")
        host._require_token = require_token
        coalescing = types.ModuleType("hermes_cli.web_read_coalescing")
        # Host behavior is a fixture; installed Hermes acceptance is a separate gate.
        coalescing.coalesced_read = lambda fn: (lambda *args: asyncio.to_thread(fn, *args))
        cls.modules = patch.dict(sys.modules, {"hermes_constants": constants, "hermes_cli.web_server": host,
                                               "hermes_cli.web_read_coalescing": coalescing})
        cls.modules.start()
        cls.api = load("yer_test_api", ROOT / "dashboard" / "plugin_api.py")

    @classmethod
    def tearDownClass(cls):
        cls.modules.stop()
        cls.home.cleanup()

    def setUp(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        self.server = FixtureServer()
        self.addCleanup(self.server.close)
        self.write_config(self.server.source_id)
        self.env = patch.dict(os.environ, {"YER_FIXTURE_TOKEN": "fixture-adapter-token"})
        self.env.start()
        self.addCleanup(self.env.stop)
        app = FastAPI()
        app.include_router(self.api.router, prefix="/api/plugins/yer-engineering")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.base = "/api/plugins/yer-engineering"
        self.headers = {"Authorization": "Bearer fixture-host-token"}
        self.scope = {"connection": "fixture-host", "profile": "fixture-profile", "chat": "durable-chat", "project": "p"}

    def write_config(self, source_id):
        (Path(self.home.name) / "yer-engineering.json").write_text(json.dumps({
            "schema_version": 1, "endpoint": self.server.endpoint, "source_id": source_id,
            "connection_id": "fixture-host", "profile": "fixture-profile", "token_env": "YER_FIXTURE_TOKEN"}), encoding="utf-8")

    def test_host_auth_csrf_origin_scope_and_exact_control_forwarding(self):
        self.assertEqual(self.client.get(self.base + "/connection").status_code, 401)
        connection = self.client.get(self.base + "/connection", headers=self.headers).json()
        route = self.base + "/tickets/" + str(uuid4()) + "/confirm"
        payload = {"preview_id": str(uuid4()), "payload_digest": "a" * 64, "scope": self.scope}
        self.assertEqual(self.client.post(route, headers=self.headers, json=payload).status_code, 403)
        self.assertEqual(len([call for call in self.server.calls if call[0] == "POST"]), 0)
        payload["csrf"] = connection["csrf"]
        self.assertEqual(self.client.post(route, headers={**self.headers, "Origin": "https://untrusted.invalid"},
                                          json=payload).status_code, 403)
        self.assertEqual(self.client.post(route, headers=self.headers, json={**payload,
            "scope": {**self.scope, "profile": "other"}}).status_code, 409)
        response = self.client.post(route, headers=self.headers, json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("csrf", response.json()["request"])
        self.assertEqual(response.json()["request"]["scope"], self.scope)
        self.assertEqual(len([call for call in self.server.calls if call[0] == "POST"]), 1)

    def test_configuration_refresh_and_preserved_source_error(self):
        result = self.client.get(self.base + "/connection", headers=self.headers).json()
        self.assertEqual(result["source_id"], self.server.source_id)
        self.write_config(str(uuid4()))
        result = self.client.get(self.base + "/connection", headers=self.headers).json()
        self.assertEqual(result["error"]["code"], "YER_IDENTITY_MISMATCH")
        self.assertNotIn("fixture-adapter-token", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
