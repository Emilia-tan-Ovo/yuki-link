import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { publicError } from './errors.js';

export function createMcpServer(manager) {
  const server = new McpServer({ name: 'codex-session-bridge', version: '0.1.0' });
  const message = {
    request_id: z.string().min(1).max(128).describe('Caller-generated idempotency key. Reuse with identical arguments after a disconnect; use a NEW key for a new message.'),
    prompt: z.string().min(1).max(131072).describe('Complete prompt, passed verbatim through UTF-8 stdin. The bridge does not interpret skills.'),
    sender: z.string().max(80).optional().describe('Observable sender label, e.g. Emilia. This is not an authenticated identity.'),
    model: z.string().min(1).max(128).optional().describe('Exact model from codex_list_models. Start default: gpt-6-astra; send default: inherit session.'),
    reasoning: z.string().min(1).max(128).optional().describe('Exact supported reasoning from codex_list_models. Start default: high; send default: inherit session.'),
    timeout_ms: z.number().int().min(1000).max(1800000).optional(),
  };
  const register = (name, description, inputSchema, action, readOnly = false) => {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: !readOnly },
    }, async input => {
      try {
        const result = await action(input);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = { error: publicError(error) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  };
  register('codex_list_models', 'Read the current local Codex model and reasoning catalog. No model inference is started.', {
    refresh: z.boolean().optional(),
  }, ({ refresh }) => manager.catalog.list(refresh), true);
  register('codex_start_session', 'Start a new managed Codex conversation and asynchronously submit its first message. Returns run_id without waiting for model completion. Poll status/output.', {
    cwd: z.string().min(1).describe('Absolute existing working directory inside the administrator allowlist.'), ...message,
  }, input => manager.start(input));
  register('codex_send_message', 'Submit a new turn to the specified bridge session using its exact saved Codex thread ID. One active run per session. Model/reasoning change only when explicitly provided.', {
    session_id: z.string().uuid(), ...message,
  }, input => manager.send(input));
  register('codex_get_status', 'Read current session configuration, selected run state, timestamps, completion/error and final reply. completed/failed/stopped/timed_out/interrupted are terminal run states.', {
    session_id: z.string().uuid().optional(), run_id: z.string().uuid().optional(),
  }, input => manager.status(input), true);
  register('codex_get_output', 'Read durable events after a cursor. Preserve next_cursor for polling. Client disconnects do not cancel runs. Events include sender text, Codex messages, stderr and lifecycle.', {
    run_id: z.string().uuid(), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(),
  }, input => manager.output(input), true);
  register('codex_stop_session', 'Stop only the active run of this managed session. Preserve its history for later resume. stopping is not yet stopped; poll status until terminal.', {
    session_id: z.string().uuid(),
  }, ({ session_id }) => manager.stop(session_id));
  return server;
}
