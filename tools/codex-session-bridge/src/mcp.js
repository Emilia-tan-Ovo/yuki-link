import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { publicError } from './errors.js';

export function createMcpServer(manager, computer) {
  const server = new McpServer({ name: 'yuki-computer-agent', version: '0.2.0' });
  const message = {
    request_id: z.string().min(1).max(128).describe('Caller-generated idempotency key. Reuse with identical arguments after a disconnect; use a NEW key for a new message.'),
    prompt: z.string().min(1).max(131072).describe('Complete prompt, passed verbatim through UTF-8 stdin. The bridge does not interpret skills.'),
    sender: z.string().max(80).optional().describe('Observable sender label, e.g. Assistant. This is not an authenticated identity.'),
    model: z.string().min(1).max(128).optional().describe('Exact model from codex_list_models. Start default: gpt-6-astra; send default: inherit session.'),
    reasoning: z.string().min(1).max(128).optional().describe('Exact supported reasoning from codex_list_models. Start default: high; send default: inherit session.'),
    timeout_ms: z.number().int().min(1000).max(1800000).optional(),
  };
  const register = (name, description, inputSchema, action, readOnly = false, idempotent = true, destructive = false) => {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: !readOnly },
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
  if (computer) {
    register('powershell', 'Direct PowerShell 7 read-only query, independent of Codex. query must be version, location, system or processes. Arbitrary scripts, native commands, deletion and system changes are not supported.', {
      cwd: z.string().min(1), query: z.enum(['version', 'location', 'system', 'processes']),
      timeout_ms: z.number().int().min(1000).max(30000).optional(),
    }, input => computer.powershell(input), true);
    register('powershell_execute', 'Execute a short noninteractive PowerShell script directly, without Codex. May modify files, run native commands or access external systems. Not idempotent: never blindly retry an unknown result. cwd is separate from script. Default 30s, maximum 30s, then at most 5s termination cleanup; combined output 1 MiB. Failures preserve partial output in error.details.result.', z.object({
      cwd: z.string().min(1),
      script: z.string().min(1).max(131072).describe('Complete PowerShell text, passed verbatim over UTF-8 JSON stdin; at most 128 KiB UTF-8. No interactive stdin.'),
      timeout_ms: z.number().int().min(1000).max(30000).optional(),
    }).strict(), input => computer.powershellExecute(input), false, false, true);
    register('filesystem_list', 'List allowed files/directories with pagination. Protected paths, credentials and links are omitted. No glob expansion.', {
      path: z.string().min(1), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(),
    }, input => computer.filesystem.list(input), true);
    register('filesystem_read', 'Read one allowed UTF-8 text file up to 256 KiB and return its SHA-256. Credential/runtime/config paths and links are denied.', {
      path: z.string().min(1),
    }, input => computer.filesystem.read(input), true);
    register('filesystem_write', 'Create a UTF-8 workspace file, or replace it only with the current expected_sha256 from filesystem_read. Parent must exist. Agent code/configuration and credentials are protected.', {
      path: z.string().min(1), content: z.string().max(262144), expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }, input => computer.filesystem.write(input), false, true, true);
    register('filesystem_move', 'Move one ordinary UTF-8 workspace file to a new, nonexisting same-volume path. Requires source expected_sha256. No directories, overwrites, credential paths or links.', {
      source: z.string().min(1), destination: z.string().min(1), expected_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }, input => computer.filesystem.move(input), false, false, true);
    register('git_status', 'Read local repository status. No index refresh locks, fsmonitor hooks, submodule traversal, network, commit or push. Repository root must be within read roots.', {
      cwd: z.string().min(1),
    }, input => computer.gitQuery(input, 'status'), true);
    register('git_diff', 'Read an unstaged or staged diff for one existing allowed UTF-8 file. No directory-wide diff, deleted paths, external diff/textconv, network, commit or push.', {
      cwd: z.string().min(1), path: z.string().min(1), staged: z.boolean().optional(),
    }, input => computer.gitQuery(input, 'diff'), true);
  }
  return server;
}
