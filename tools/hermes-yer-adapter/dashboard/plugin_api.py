"""Thin authenticated Hermes backend. YER remains the execution authority."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from hermes_cli.web_read_coalescing import coalesced_read

_spec = importlib.util.spec_from_file_location(__name__ + "_client", Path(__file__).with_name("yer_client.py"))
_client_module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _client_module
_spec.loader.exec_module(_client_module)
YerClient, YerError = _client_module.YerClient, _client_module.YerError

router = APIRouter()
_csrf_key = secrets.token_bytes(32)


def _authenticate(request):
    # Reuse the host's actual bearer/cookie identity gate even on loopback.
    from hermes_cli.web_server import _require_token
    _require_token(request)
    origin = request.headers.get("origin")
    if origin and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "ORIGIN_MISMATCH")
    session = getattr(request.state, "session", None)
    principal = request.headers.get("authorization") or request.headers.get("x-hermes-session-token")
    if not principal and session is not None:
        principal = str(getattr(session, "id", None) or getattr(session, "session_id", None) or session)
    if not principal:
        raise HTTPException(403, "HOST_IDENTITY_UNAVAILABLE")
    return hashlib.sha256(principal.encode("utf-8")).hexdigest()


def _connection():
    # Refresh profile-private endpoint/source configuration on every request.
    return _client_module.configured_client(include_control_token=True)


def _scope(body, config):
    value = body.get("scope")
    if (not isinstance(value, dict) or set(value) != {"connection", "profile", "chat", "project"}
            or any(not isinstance(v, str) or not v or len(v) > 512 for v in value.values())):
        raise HTTPException(400, "INVALID_SCOPE")
    # The connection/profile route comes from the configured host. Chat/project
    # are reference scopes only; YER still validates Ticket/worktree binding.
    if value["connection"] != config["connection_id"] or value["profile"] != config["profile"]:
        raise HTTPException(409, "HOST_SCOPE_CHANGED")
    return value


def _csrf(principal, source_id, expires):
    message = f"{principal}:{source_id}:{expires}".encode()
    return f"{expires}." + hmac.new(_csrf_key, message, hashlib.sha256).hexdigest()


def _check_csrf(body, principal, source_id):
    supplied = body.get("csrf", "")
    try:
        expires = int(supplied.split(".")[0])
        if expires < time.time() or expires > time.time() + 601:
            raise ValueError()
        if not hmac.compare_digest(supplied, _csrf(principal, source_id, expires)):
            raise ValueError()
    except (AttributeError, ValueError, TypeError):
        raise HTTPException(403, "UI_CONFIRMATION_REQUIRED") from None


def _ticket(value):
    try:
        return str(UUID(value))
    except ValueError:
        raise HTTPException(400, "INVALID_TICKET") from None


@coalesced_read
def _read(source_id, port, route):
    return YerClient(f'http://127.0.0.1:{port}', source_id).request('GET', route)


async def _call(client, method, route, payload=None):
    try:
        if method == 'GET':
            return await _read(client.source_id, client.port, route)
        return await asyncio.to_thread(client.request, method, route, payload)
    except YerError as error:
        return {**error.public(), 'source_http_status': error.status}


@router.get("/connection")
async def connection(request: Request):
    principal = _authenticate(request)
    try:
        client, config = _connection()
        identity = await asyncio.to_thread(client.identity)
        return {**identity, "connection_id": config["connection_id"], "profile": config["profile"],
                "csrf": _csrf(principal, client.source_id, int(time.time()) + 600)}
    except YerError as error:
        return {**error.public(), 'source_http_status': error.status}


@router.get("/tickets")
async def tickets(request: Request):
    _authenticate(request)
    client, _ = _connection()
    return await _call(client, "GET", "/engineering/tickets")


@router.get("/tickets/{ticket_id}")
async def snapshot(ticket_id: str, request: Request):
    _authenticate(request)
    client, _ = _connection()
    return await _call(client, "GET", "/engineering/tickets/" + _ticket(ticket_id))


@router.get("/tickets/{ticket_id}/{kind}")
async def observation(ticket_id: str, kind: str, request: Request):
    _authenticate(request)
    if kind not in ("events", "patch", "operations"):
        raise HTTPException(404, "NOT_FOUND")
    allowed = {"events": {"source_id", "after", "until", "limit", "conversation_id"},
               "patch": {"file_id", "revision", "mode"}, "operations": {"request_id"}}[kind]
    if set(request.query_params) - allowed:
        raise HTTPException(400, "INVALID_QUERY")
    client, _ = _connection()
    route = "/engineering/tickets/" + _ticket(ticket_id) + "/" + kind + "?" + urlencode(dict(request.query_params))
    return await _call(client, "GET", route)


@router.post("/tickets/{ticket_id}/{kind}")
async def control(ticket_id: str, kind: str, request: Request):
    principal = _authenticate(request)
    if kind not in ("preview", "confirm", "actions"):
        raise HTTPException(404, "NOT_FOUND")
    client, config = _connection()
    raw = await request.body()
    if len(raw) > 1024 * 1024:
        raise HTTPException(413, "REQUEST_TOO_LARGE")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "INVALID_JSON") from None
    if not isinstance(body, dict):
        raise HTTPException(400, "INVALID_REQUEST")
    _check_csrf(body, principal, client.source_id)
    _scope(body, config)
    allowed = {"preview": {"plan_id"}, "confirm": {"preview_id", "payload_digest"}, "actions": {"action"}}[kind]
    if set(body) - allowed - {"csrf", "scope"}:
        raise HTTPException(400, "INVALID_REQUEST")
    payload = {key: value for key, value in body.items() if key not in ("csrf",)}
    if kind == "actions":
        payload = body["action"]
    return await _call(client, "POST", "/engineering/tickets/" + _ticket(ticket_id) + "/" + kind, payload)
