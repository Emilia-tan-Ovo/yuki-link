import { z } from 'zod';

const id = z.string().uuid();
const flag = z.union([z.boolean(), z.literal('unknown')]);
export const taskOutputSchema = z.object({
  limit_bytes: z.number(), stdout_bytes: z.number(), stderr_bytes: z.number(),
  pipes_closed: z.boolean(), stdout_truncated: z.boolean(), stderr_truncated: z.boolean(),
  incomplete: z.boolean(), redacted: z.boolean(),
});
export const taskSnapshotSchema = z.object({
  task_id: z.string(), status: z.string(), root_state: z.string(),
  exit_code: z.number().nullable(), signal: z.string().nullable(), completion_reason: z.string().nullable(),
  termination: z.object({ requested: z.boolean(), tree_kill: z.string(), attempts: z.number(),
    error: z.unknown().optional() }),
  tracking_scope: z.string(), timeout_ms: z.number(), output: taskOutputSchema,
  audit: z.string(), error: z.unknown(), created_at: z.string(), started_at: z.string().nullable(), finished_at: z.string().nullable(),
});
export const taskIdentitySchema = z.object({
  task_id: z.string().max(80), service_epoch: id, request_id: z.string(), ticket_id: id,
  cwd: z.string(), timeout_ms: z.number(), created_at: z.string(),
});
export const taskBindingSchema = taskIdentitySchema.extend({ binding_id: id, conversation_id: id, source_id: id, metadata_redacted: z.boolean() });
export const taskRecordSchema = z.object({
  binding: taskBindingSchema, category: z.enum(['output', 'lifecycle', 'observation']),
  seq: z.number().int().nonnegative().nullable(), kind: z.string(), source_at: z.string().nullable(),
  source: z.literal('yca-owned-task'), payload: z.unknown(), snapshot: taskSnapshotSchema.nullable(),
  integrity: z.object({
    policy: z.literal('bridge-redact-v1'), script: z.literal('source-not-provided'),
    capture: z.enum(['observed', 'collection-failed']),
    redacted: z.boolean(), source_redaction: flag, truncated: flag, incomplete: flag,
    stdout: z.enum(['observed', 'not-yet-observed', 'collection-failed']),
    stderr: z.enum(['observed', 'not-yet-observed', 'collection-failed']),
    exit_code: z.enum(['observed', 'not-yet-observed', 'source-not-provided', 'collection-failed']),
  }),
});
export type TaskIdentity = z.infer<typeof taskIdentitySchema>;
export type TaskBinding = z.infer<typeof taskBindingSchema>;
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export interface TaskLine { seq: number; stream: 'stdout' | 'stderr'; text: string }
export interface TaskNotice {
  category: 'output' | 'lifecycle'; seq: number; kind: string; source_at: string | null;
  payload: unknown; snapshot: TaskSnapshot;
}
