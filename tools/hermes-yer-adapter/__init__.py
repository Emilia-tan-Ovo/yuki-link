"""Hermes agent-side doorway. Startup never opens a runtime or launches a model."""
import json

from .dashboard.yer_client import YerError, configured_client

_ALLOWED = {
    "harness_register_ticket", "harness_record_workflow", "codex_list_models",
    "assemble_ticket_context", "prepare_ticket_resume", "start_workflow_agent", "get_work_item",
    "transition_work_item", "reconcile_work_item", "get_engineering_snapshot",
    "get_engineering_events", "get_engineering_patch", "get_engineering_operation",
    "propose_engineering_action", "stop_engineering_run",
}


def _connected():
    client, _ = configured_client()
    client.mcp("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                             "clientInfo": {"name": "hermes-yer", "version": "0.1.0"}})
    return client


def list_tools(params, **kwargs):
    try:
        client = _connected()
        result = client.mcp("tools/list")
        return json.dumps({"source_id": client.source_id,
                           "tools": [tool for tool in result.get("tools", []) if tool.get("name") in _ALLOWED]},
                          ensure_ascii=False)
    except YerError as error:
        return json.dumps(error.public())


def call_tool(params, **kwargs):
    if (set(params) - {"tool", "arguments"} or params.get("tool") not in _ALLOWED
            or not isinstance(params.get("arguments", {}), dict)):
        return json.dumps({"error": {"code": "ENGINEERING_TOOL_NOT_ALLOWED"}})
    try:
        client = _connected()
        result = client.mcp("tools/call", {"name": params["tool"], "arguments": params.get("arguments", {})})
        # Preserve YER source codes and actual receipts, never derive workflow success
        # from a completed tool or a textual assistant response.
        return json.dumps(result.get("structuredContent", result), ensure_ascii=False)
    except YerError as error:
        return json.dumps(error.public())


def register(ctx):
    ctx.register_tool(name="yer_list_tools", toolset="yer-engineering", handler=list_tools, schema={
        "name": "yer_list_tools", "description": "读取已绑定 YER 的精简工程工具与精确参数 schema。普通文件/shell/Git 使用 Hermes 原生工具。",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False}})
    ctx.register_tool(name="yer_call_tool", toolset="yer-engineering", handler=call_tool, schema={
        "name": "yer_call_tool", "description": "按 yer_list_tools 返回的 schema 调用受管工程工具。提出计划不会授权；新授权由工程面板确认。断线先查原 request 的 receipt。",
        "parameters": {"type": "object", "properties": {
            "tool": {"type": "string", "enum": sorted(_ALLOWED)}, "arguments": {"type": "object"}},
            "required": ["tool", "arguments"], "additionalProperties": False}})
