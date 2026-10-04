"""Called against the isolated, real YER HTTP server by the Node contract test."""
import importlib.util
import json
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("yer_fixture_client", Path(__file__).parents[1] / "dashboard" / "yer_client.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
endpoint, source_id, ticket_id, request_id = sys.argv[1:]
for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
    os.environ[key] = "http://127.0.0.1:1"
os.environ.pop("NO_PROXY", None)
os.environ.pop("no_proxy", None)
client = module.YerClient(endpoint, source_id)
hello = client.mcp("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                 "clientInfo": {"name": "python-ipc-fixture", "version": "1"}})
assert hello["serverInfo"]["name"] == "yuki-engineering-runtime"
names = [tool["name"] for tool in client.mcp("tools/list")["tools"]]
assert "get_engineering_operation" in names
assert "powershell_execute" not in names
result = client.mcp("tools/call", {"name": "get_engineering_operation",
                                  "arguments": {"ticket_id": ticket_id, "request_id": request_id}})
assert not result.get("isError"), result
receipt = result["structuredContent"]
assert receipt["request_id"] == request_id and receipt["runtime"]["run_id"]
print(json.dumps({"source_id": source_id, "operation_id": receipt["operation_id"],
                  "run_id": receipt["runtime"]["run_id"], "proxy_bypassed": True}))
