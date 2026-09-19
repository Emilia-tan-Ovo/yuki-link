import { z } from 'zod';
import { taskRecordSchema } from './task-model.ts';
import { workflowObservationRecordSchema, workflowSnapshotRecordSchema } from './workflow-model.ts';

const id = z.string().uuid();
const text = z.string().min(1).max(512);
export const registrationSchema = z.object({
  project_key: text, project_name: text, ticket_key: text, title: text,
  reference: text, expected_worktree: text.optional(),
}).strict();
export const attachSchema = z.object({ ticket_id: id, session_id: id, run_id: id.optional() }).strict();
export type Registration = z.infer<typeof registrationSchema>;
export type Attachment = z.infer<typeof attachSchema>;
export const projectSchema = z.object({ id, key: text, name: text });
export const ticketSchema = z.object({
  id, project_id: id, key: text, title: text, reference: text,
  main_conversation_id: id, expected_worktree: z.string().nullable(),
});
export const bindingSchema = z.object({
  id, ticket_id: id, conversation_id: id, source_id: id,
  session_id: id, scope: z.enum(['session', 'run']), run_id: id.nullable(), attached_at: text,
});
export type Project = z.infer<typeof projectSchema>;
export type Ticket = z.infer<typeof ticketSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export const eventSchema = z.object({
  ticket_id: id, conversation_id: id, binding_id: id, session_id: id,
  run_id: id.nullable(), thread_id: z.string().nullable(),
  source_seq: z.number().int().nonnegative().nullable(), source_at: z.string().nullable(),
  kind: text, payload: z.unknown(),
  integrity: z.object({
    source_redaction: z.literal('unknown'), redacted: z.boolean(),
    truncated: z.enum(['unknown', 'source-output-limit']),
  }),
});
export type Event = z.infer<typeof eventSchema>;
export const computerToolSchema = z.enum(['powershell', 'powershell_execute', 'filesystem_list', 'filesystem_read',
  'filesystem_write', 'filesystem_move', 'git_status', 'git_diff']);
const fieldState = z.enum(['observed', 'source-not-provided', 'not-yet-observed', 'collection-failed']);
const sourceFlag = z.union([z.boolean(), z.literal('unknown')]);
export const computerCallSchema = z.object({
  call_id: id, ticket_id: id, conversation_id: id, tool: computerToolSchema,
  stage: z.enum(['started', 'result']), outcome: z.enum(['not-yet-observed', 'succeeded', 'failed']),
  capture: z.enum(['observed', 'collection-failed']), source: z.literal('yca-sync-public-result'),
  source_at: z.string(), input: z.unknown(), result: z.unknown(), error: z.unknown(), attribution: z.unknown(),
  integrity: z.object({ policy: z.literal('bridge-redact-v1'), redacted: z.boolean(),
    source_redaction: sourceFlag, truncated: sourceFlag, incomplete: sourceFlag,
    stdout: fieldState, stderr: fieldState, exit_code: fieldState,
  }),
});
export type ComputerCall = z.infer<typeof computerCallSchema>;
export type ComputerTool = z.infer<typeof computerToolSchema>;
export const recordSchema = z.object({
  schema_version: z.literal(1), cursor: z.number().int().positive(),
  event_id: id, source_id: id, observed_at: text,
  data: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('source') }),
    z.object({ kind: z.literal('registered'), project: projectSchema, ticket: ticketSchema }),
    z.object({ kind: z.literal('attached'), binding: bindingSchema, previous_session_id: id.nullable() }),
    z.object({ kind: z.literal('event'), event: eventSchema }),
    z.object({ kind: z.literal('computer_call'), call: computerCallSchema }),
    z.object({ kind: z.literal('owned_task'), task: taskRecordSchema }),
    z.object({ kind: z.literal('workflow_snapshot'), workflow: workflowSnapshotRecordSchema }),
    z.object({ kind: z.literal('workflow_observation'), workflow: workflowObservationRecordSchema }),
  ]),
});
export type RecordEntry = z.infer<typeof recordSchema>;
export type Operation = RecordEntry['data'];
export interface SourceEvent { seq: number; at: string; session_id: string; run_id: string; type: string; data: unknown }
export interface SourceRun {
  id: string; session_id: string; created_at: string; model: string; reasoning: string;
  status: string; config_source: string; timeout_ms: number | null; exit_code: number | null;
}
export interface SourceSession { id: string; cwd: string; codex_thread_id: string | null; permissions: unknown }
export interface Source {
  session(id: string): SourceSession;
  runs(sessionId: string): SourceRun[];
  events(run: SourceRun): SourceEvent[];
  attribution(ticket: Ticket, session?: SourceSession): unknown;
}
export class HarnessError extends Error {
  code: string;
  details: unknown;
  constructor(code: string, details: unknown = {}) { super(code); this.code = code; this.details = details; }
}
