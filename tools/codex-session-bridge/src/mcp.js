import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { publicError } from './errors.js';
import { SANDBOX_MODE_VALUES, APPROVAL_POLICY_VALUES, APPROVAL_REVIEWER_VALUES } from './permissions.js';
import { registrationSchema, attachSchema, HarnessError } from './harness/model.ts';
import { gateHarnessExecution } from './harness/harness.ts';
import { childAssociationSchema } from './harness/conversation-model.ts';
import { ContextAssembler } from './orchestration/context-assembler.ts';
import { HarnessContextFactsSource } from './orchestration/harness-context-source.ts';
import { startTicketImplementationInputSchema } from './orchestration/implementation-launcher.ts';
import { DEFAULT_MODEL, DEFAULT_REASONING } from './model-policy.js';
import { startTicketReviewInputSchema } from './orchestration/review-launcher.ts';
import { WorkflowAgentLauncher, startWorkflowAgentInputSchema } from './orchestration/workflow-agent-launcher.ts';

export function createMcpServer(manager, computer) {
  const server = new McpServer({ name: 'yuki-computer-agent', version: '0.2.0' });
  const withGateEvidence = (result, gate) => {
    if (!gate.evidence_gap) return result;
    const response = result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
    return { ...response, harness_recording: response.harness_recording ?? gate.recording, evidence_gap: gate.evidence_gap };
  };
  const message = {
    request_id: z.string().min(1).max(128).describe('Caller-generated idempotency key. Reuse with identical arguments after a disconnect; use a NEW key for a new message.'),
    prompt: z.string().min(1).max(131072).describe('Complete prompt, passed verbatim through UTF-8 stdin. The bridge does not interpret skills.'),
    sender: z.string().max(80).optional().describe('Observable sender label, e.g. Assistant. This is not an authenticated identity.'),
    model: z.string().min(1).max(128).optional().describe(`Exact model from codex_list_models. Start default: ${DEFAULT_MODEL}; send default: inherit session.`),
    reasoning: z.string().min(1).max(128).optional().describe(`Exact supported reasoning from codex_list_models. Start default: ${DEFAULT_REASONING}; send default: inherit session.`),
    timeout_ms: z.number().int().min(1000).max(1800000).optional().describe('Explicit hard execution deadline for this run. Omit for no wall-clock execution deadline.'),
  };
  const permissions = z.object({
    sandbox_mode: z.enum(SANDBOX_MODE_VALUES).describe('Codex native sandbox mode to freeze for this new session.'),
    approval_policy: z.enum(APPROVAL_POLICY_VALUES).optional().describe('Codex native approval policy. Omit to inherit the effective local default at session creation.'),
    approvals_reviewer: z.enum(APPROVAL_REVIEWER_VALUES).optional().describe('Approval reviewer. Omit to inherit and freeze the effective local default.'),
  }).strict().optional();
  const register = (category, name, description, inputSchema, action, readOnly = false, idempotent = true, destructive = false, synchronous = false) => {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: !readOnly },
    }, async (input, extra) => {
      try {
        const gate = gateHarnessExecution(manager.harness, category);
        let result, isError = false;
        if (synchronous && input.ticket_id !== undefined) {
          const { ticket_id, ...argumentsOnly } = input;
          if (typeof manager.harness?.computerCalls?.run === 'function') {
            const recorded = await manager.harness.computerCalls.run(
              name, ticket_id, argumentsOnly, () => action(argumentsOnly, extra), category === 'new-side-effect',
            );
            result = recorded.response; isError = recorded.isError;
          } else result = await action(argumentsOnly, extra);
        } else result = await action(input, extra);
        result = withGateEvidence(result, gate);
        return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = { error: error instanceof HarnessError ? { code: error.code, message: error.message, details: error.details } : publicError(error) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  };
  const registerComputer = (category, name, description, inputSchema, action, readOnly = false, idempotent = true, destructive = false) => {
    const attribution = { ticket_id: z.string().uuid().optional().describe('Explicit registered Harness Ticket. Omit to preserve legacy behavior; never inferred. Recording failure does not retry execution.') };
    const schema = inputSchema instanceof z.ZodObject ? inputSchema.extend(attribution) : { ...inputSchema, ...attribution };
    register(category, name, description, schema, (input, extra) => {
      if (computer.closing) throw new HarnessError('SHUTTING_DOWN');
      return action(input, extra);
    }, readOnly, idempotent, destructive, true);
  };
  register('record-only', 'harness_register_ticket', 'Explicitly register a Project/Ticket, its stable main Conversation, and when expected_worktree plus fixed_point are supplied, an immutable Git comparison baseline with a start observation. Identical input is idempotent; a different baseline conflicts. No engineering task is started.',
    registrationSchema, input => {
      if (!manager.harness) throw new HarnessError('HARNESS_UNAVAILABLE');
      return manager.harness.register(input);
    });
  register('record-only', 'harness_attach', 'Compatibility, diagnostic or administrator attribution path. Normal Repository Engineer Workflow uses start_workflow_agent. Attach an existing Codex session or one run to a registered Ticket; no model call or resume.',
    attachSchema, input => {
      if (!manager.harness) throw new HarnessError('HARNESS_UNAVAILABLE');
      return manager.harness.attach(input);
    });
  register('record-only', 'harness_record_workflow', 'Record a complete structured Workflow snapshot for an explicitly registered Ticket. This only records and checks cited evidence; it does not run Review, Acceptance, tests, Git writes or model work.',
    // Accept raw fields here so the record layer can return bounded validation diagnostics
    // through the public error envelope instead of an SDK-level schema error.
    z.object({ ticket_id: z.unknown().optional(), request_id: z.unknown().optional(),
      expected_revision: z.unknown().optional(), schema_version: z.unknown().optional(),
      snapshot: z.unknown().optional() }).passthrough(), input => {
      if (!manager.harness) throw new HarnessError('HARNESS_UNAVAILABLE');
      return manager.harness.recordWorkflow(input);
    });
  register('record-only', 'harness_associate_child_conversation', 'Compatibility, diagnostic or administrator attribution path. Normal Repository Engineer Workflow uses start_workflow_agent. Record an already-started Review or Acceptance Agent run as a child Conversation.',
    childAssociationSchema, input => {
      if (!manager.harness) throw new HarnessError('HARNESS_UNAVAILABLE');
      return manager.harness.associateChildConversation(input);
    });
  register('observe', 'codex_list_models', 'Read the current local Codex model and reasoning catalog. No model inference is started.', {
    refresh: z.boolean().optional(),
  }, ({ refresh }) => manager.catalog.list(refresh), true);
  const contextInput = z.object({
    ticket_id: z.string().uuid(),
    requested_action: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
    trigger: z.enum(['manual', 'handoff', 'interruption', 'service-restart']),
  }).strict();
  const contextAssembler = () => {
    if (!manager.harness) throw new HarnessError('HARNESS_UNAVAILABLE');
    // Supplied by the trusted outer reader; MCP callers cannot assert source observation facts.
    const observations = manager.canonicalSpecObservations instanceof Map
      ? manager.canonicalSpecObservations : new Map();
    return new ContextAssembler(new HarnessContextFactsSource(manager.harness, undefined, observations,
      manager.implementationLaunchAuthority ?? null));
  };
  register('observe', 'assemble_ticket_context', 'Assemble a bounded, versioned Context Packet from current durable facts. This is read-only and does not refresh sources, start execution, advance Workflow, or write the Context Plan.',
    contextInput, input => contextAssembler().assemble(input), true);
  register('observe', 'prepare_ticket_resume', 'Prepare a read-only recovery projection and deterministic next-action recommendation from a Context Packet. This never starts or resumes execution, advances Workflow, or replays side effects.',
    contextInput, input => contextAssembler().prepare(input), true);
  const workflowAgent = () => {
    if (!manager.harness) throw new HarnessError('HARNESS_UNAVAILABLE');
    return new WorkflowAgentLauncher({ manager, harness: manager.harness,
      implementationAuthority: manager.implementationLaunchAuthority,
      reviewAuthority: manager.reviewLaunchAuthority,
      workflowAuthority: manager.workflowAgentAuthority });
  };
  register('manage-existing', 'start_workflow_agent', 'Preferred high-level typed Workflow Agent launcher. Fixes fresh session, destination, phase policy and Owner native permissions; returns one durable execution receipt.',
    startWorkflowAgentInputSchema, input => workflowAgent().start(input));
  register('manage-existing', 'start_ticket_implementation', 'Compatibility wrapper for start_workflow_agent implementation; delegated Review and Ticket Main destination remain fixed.',
    startTicketImplementationInputSchema, input => {
      return workflowAgent().start({ ...input, action: 'implementation' });
    });
  register('manage-existing', 'start_ticket_review', 'Compatibility wrapper for start_workflow_agent Review; a durable Review child reservation precedes model launch.',
    startTicketReviewInputSchema, input => {
      return workflowAgent().start({ ...input, action: 'review' });
    });
  register('new-side-effect', 'codex_start_session', 'Compatibility, diagnostic or administrator path. Normal Repository Engineer Workflow uses start_workflow_agent. Start a managed Codex conversation and freeze effective native permissions.', {
    cwd: z.string().min(1).describe('Absolute existing working directory inside the administrator allowlist.'), permissions, ...message,
  }, input => manager.start(input));
  register('new-side-effect', 'codex_send_message', 'Submit a new turn to the specified bridge session using its exact saved Codex thread ID. One active run per session. Model/reasoning change only when explicitly provided. Permissions are frozen at session creation; supplying permissions here is rejected.', {
    session_id: z.string().uuid(), permissions: z.unknown().optional(), ...message,
  }, input => manager.send(input));
  register('observe', 'codex_get_status', 'Read current session configuration, selected run state, timestamps, completion/error and final reply. completed/failed/stopped/timed_out/interrupted are terminal run states.', {
    session_id: z.string().uuid().optional(), run_id: z.string().uuid().optional(),
  }, input => manager.status(input), true);
  register('observe', 'codex_get_output', 'Read durable events after a cursor. Optionally wait for new events, a terminal run, or the observation window to elapse. Preserve next_cursor. Cancelling this observation or disconnecting does not stop the run.', {
    run_id: z.string().uuid(), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(),
    wait_ms: z.number().int().min(0).max(60_000).optional().describe('Observation window only. Omit or use 0 for an immediate snapshot; this never sets or extends the run execution deadline.'),
  }, (input, extra) => manager.output(input, { signal: extra.signal }), true);
  register('manage-existing', 'codex_stop_session', 'Stop only the active run of this managed session. Preserve its history for later resume. stopping is not yet stopped; poll status until terminal.', {
    session_id: z.string().uuid(),
  }, ({ session_id }) => manager.stop(session_id));
  if (computer) {
    register('observe', 'task_status', 'Read a directly owned task, or obtain the service epoch and task budgets without an ID. No model calls.', z.object({
      task_id: z.string().max(80).optional(),
    }).strict(), input => computer.tasks.status(input), true);
    register('new-side-effect', 'task_start', 'Start a foreground noninteractive PowerShell task without Codex. Save task_id; retry identical input with the same epoch and request_id to recover acceptance.', z.object({
      ticket_id: z.string().uuid().optional().describe('Explicit registered Harness Ticket, fixed at acceptance. Omit for legacy behavior. Changing attribution on a request_id conflicts. Full script is not retained in Harness history.'),
      service_epoch: z.string().uuid(), request_id: z.string().min(1).max(128), cwd: z.string().min(1),
      script: z.string().min(1).max(131072), timeout_ms: z.number().int().min(1000).max(1800000).optional(),
    }).strict(), input => {
      if (input.ticket_id !== undefined && !manager.harness) throw new HarnessError('HARNESS_UNAVAILABLE');
      const result = computer.tasks.start(input, id => manager.harness.taskHistory.validateTicket(id));
      return input.ticket_id === undefined ? result : { ...result, harness_recording: manager.harness.taskHistory.receipt(result.task_id) };
    }, false, true, true);
    register('observe', 'task_output', 'Read immutable stdout/stderr line events after a cursor. No new events does not mean completion.', z.object({
      task_id: z.string().max(80), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(),
    }).strict(), input => computer.tasks.output(input), true);
    register('manage-existing', 'task_stop', 'Request stopping only this owned foreground task. Poll status: a request or a successful tree-kill command is not proof of termination. Retry explicitly after failure.', z.object({
      task_id: z.string().max(80),
    }).strict(), input => computer.tasks.stop(input), false, false, true);
    registerComputer('observe', 'powershell', 'Direct PowerShell 7 read-only query, independent of Codex. query must be version, location, system or processes. Arbitrary scripts, native commands, deletion and system changes are not supported.', {
      cwd: z.string().min(1), query: z.enum(['version', 'location', 'system', 'processes']),
      timeout_ms: z.number().int().min(1000).max(30000).optional(),
    }, input => computer.powershell(input), true);
    registerComputer('new-side-effect', 'powershell_execute', 'Execute a short noninteractive PowerShell script directly, without Codex. May modify files, run native commands or access external systems. Not idempotent: never blindly retry an unknown result. cwd is separate from script. Default 30s, maximum 30s, then at most 5s termination cleanup; combined output 1 MiB. Failures preserve partial output in error.details.result.', z.object({
      cwd: z.string().min(1),
      script: z.string().min(1).max(131072).describe('Complete PowerShell text, passed verbatim over UTF-8 JSON stdin; at most 128 KiB UTF-8. No interactive stdin.'),
      timeout_ms: z.number().int().min(1000).max(30000).optional(),
    }).strict(), input => computer.powershellExecute(input), false, false, true);
    registerComputer('observe', 'filesystem_list', 'List allowed files/directories with pagination. Protected paths, credentials and links are omitted. No glob expansion.', {
      path: z.string().min(1), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(),
    }, input => computer.filesystem.list(input), true);
    registerComputer('observe', 'filesystem_read', 'Read one explicitly addressed absolute local UTF-8 text file up to 256 KiB, including outside read roots and .agents/skills or .codex/skills documents. Preserve BOM/newlines and hash the complete raw bytes. Oversize files fail without truncation. Other protected components, runtime/control configuration, credential-like content and links remain denied. Reading a Skill does not execute it.', {
      path: z.string().min(1),
    }, input => computer.filesystem.read(input), true);
    registerComputer('new-side-effect', 'filesystem_write', 'Create a UTF-8 workspace file, or replace different content only with the current expected_sha256 from filesystem_read. Identical content returns changed:false without writing, even with a missing or stale hash; this is not hash validation. Parent must exist. Agent code/configuration and credentials are protected.', {
      path: z.string().min(1), content: z.string().max(262144), expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }, input => computer.filesystem.write(input), false, true, true);
    registerComputer('new-side-effect', 'filesystem_move', 'Move one ordinary UTF-8 workspace file to a new, nonexisting same-volume path. Requires source expected_sha256. No directories, overwrites, credential paths or links.', {
      source: z.string().min(1), destination: z.string().min(1), expected_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }, input => computer.filesystem.move(input), false, false, true);
    registerComputer('observe', 'git_status', 'Read local repository status. No index refresh locks, fsmonitor hooks, submodule traversal, network, commit or push. Repository root must be within read roots.', {
      cwd: z.string().min(1),
    }, input => computer.gitQuery(input, 'status'), true);
    registerComputer('observe', 'git_diff', 'Read an unstaged or staged diff for one existing allowed UTF-8 file. No directory-wide diff, deleted paths, external diff/textconv, network, commit or push.', {
      cwd: z.string().min(1), path: z.string().min(1), staged: z.boolean().optional(),
    }, input => computer.gitQuery(input, 'diff'), true);
  }
  return server;
}
