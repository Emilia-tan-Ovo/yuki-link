"""Pinned loopback IPC. No proxies, redirects, DNS aliases, shell or model calls."""
from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID


def configured_client(*, include_control_token=False):
    from hermes_constants import get_hermes_home
    try:
        config = json.loads((Path(get_hermes_home()) / 'yer-engineering.json').read_text(encoding='utf-8'))
        if config.get('schema_version') != 1 or any(not isinstance(config.get(key), str) or not config[key]
                                                  for key in ('connection_id', 'profile')):
            raise ValueError()
        token_env = config.get('token_env', 'YER_ADAPTER_TOKEN')
        return YerClient(config['endpoint'], config['source_id'],
                         os.environ.get(token_env) if include_control_token else None), config
    except YerError:
        raise
    except (OSError, ValueError, KeyError, TypeError):
        raise YerError('ADAPTER_NOT_CONFIGURED') from None


class YerError(Exception):
    def __init__(self, code, *, retryable=False, reconciliation_required=False, status=503):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.reconciliation_required = reconciliation_required
        self.status = status

    def public(self):
        return {"error": {"code": self.code, "retryable": self.retryable,
                          "reconciliation_required": self.reconciliation_required}}


class YerClient:
    def __init__(self, endpoint, source_id, token=None, timeout=15):
        try:
            parsed = urlsplit(endpoint)
            valid = (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port
                     and not parsed.username and not parsed.password and parsed.path in ('', '/')
                     and not parsed.query and not parsed.fragment and parsed.netloc == f'127.0.0.1:{parsed.port}')
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise YerError('LOOPBACK_ENDPOINT_REQUIRED', status=400)
        try:
            UUID(source_id)
        except (ValueError, TypeError):
            raise YerError("SOURCE_ID_REQUIRED", status=400) from None
        self.port, self.source_id, self.token, self.timeout = parsed.port, source_id, token, timeout

    def _request(self, method, route, payload=None, control=False):
        if not route.startswith(("/engineering/", "/mcp")) or "\r" in route or "\n" in route:
            raise YerError("INVALID_ROUTE", status=400)
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        if encoded is not None and len(encoded) > 1024 * 1024:
            raise YerError("REQUEST_TOO_LARGE", status=400)
        headers = {"Accept": "application/json, text/event-stream", "X-YER-Source-Id": self.source_id}
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        if control:
            if not self.token:
                raise YerError("ADAPTER_NOT_CONFIGURED", status=403)
            headers["Authorization"] = "Bearer " + self.token
        # HTTPConnection connects directly to this numeric address; environment
        # HTTP_PROXY/HTTPS_PROXY/ALL_PROXY and NO_PROXY are deliberately irrelevant.
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=self.timeout)
        try:
            conn.request(method, route, body=encoded, headers=headers)
            response = conn.getresponse()
            if 300 <= response.status < 400:
                raise YerError("REDIRECT_REFUSED", status=409)
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise YerError("RESPONSE_TOO_LARGE")
            try:
                value = json.loads(raw) if raw else {}
            except (ValueError, UnicodeDecodeError):
                raise YerError("INVALID_YER_RESPONSE") from None
            if response.status >= 400:
                detail = value.get("error", {})
                raise YerError(detail.get("code", "YER_REQUEST_FAILED"),
                               retryable=detail.get("retryable", False),
                               reconciliation_required=detail.get("reconciliation_required", False),
                               status=response.status)
            return value
        except (OSError, http.client.HTTPException):
            # POST completion is unknown; never replay here or invent a new request ID.
            raise YerError("YER_CONNECTION_UNAVAILABLE", retryable=method == "GET",
                           reconciliation_required=method == "POST") from None
        finally:
            conn.close()

    def identity(self):
        value = self._request("GET", "/engineering/identity")
        if (value.get("service") != "yuki-engineering-runtime" or value.get("protocol_version") != 1
                or value.get("source_id") != self.source_id):
            raise YerError("YER_IDENTITY_MISMATCH", status=409)
        return value

    def request(self, method, route, payload=None):
        self.identity()
        value = self._request(method, route, payload, control=method != "GET")
        if value.get("source_id", self.source_id) != self.source_id:
            raise YerError("SOURCE_CHANGED", status=409)
        return value

    def mcp(self, method, params=None, request_id=1):
        self.identity()
        value = self._request("POST", "/mcp",
                              {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        if value.get("error"):
            raise YerError("MCP_REQUEST_REJECTED", status=400)
        return value.get("result", {})
