import { z } from 'zod';
import { childRelationSchema, isolationAssessmentSchema } from './conversation-model.ts';

const id = z.string().uuid();
const text = z.string().min(1).max(512);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const subjectDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const requestedExecutionDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }).strict(),
  z.object({ kind: z.literal('child'), relation: childRelationSchema }).strict(),
]);

export const resolvedExecutionDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), conversation_id: id }).strict(),
  z.object({ kind: z.literal('child'), conversation_id: id, parent_conversation_id: id,
    relation: childRelationSchema, created_at: z.string().datetime(), isolation: isolationAssessmentSchema }).strict(),
]);

export const executionContentIdentitySchema = z.object({
  scheme: z.literal('yuki-git-subject'), version: z.literal(1), scope: z.unknown(),
  completeness: z.enum(['complete', 'incomplete']), digest: subjectDigest.nullable(),
}).strict();

const permissionSelectionSchema = z.object({
  sandbox_mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  approval_policy: z.enum(['on-request', 'never']).optional(),
  approvals_reviewer: z.enum(['user', 'auto_review', 'guardian_subagent']).optional(),
}).strict();

export const executionReserveInputSchema = z.object({
  ticket_id: id,
  request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  destination: requestedExecutionDestinationSchema,
  expected_workflow_revision: z.number().int().positive(),
  subject_ref: text,
  content_identity: executionContentIdentitySchema,
  launch: z.object({
    cwd: z.string().min(1), prompt: z.string().min(1).max(128 * 1024),
    sender: z.string().min(1).max(80).nullable().default(null),
    model: z.string().min(1).max(128).nullable().default(null),
    reasoning: z.string().min(1).max(128).nullable().default(null),
    timeout_ms: z.number().int().min(1000).max(1_800_000).nullable().default(null),
    permissions: permissionSelectionSchema.nullable().default(null),
  }).strict(),
  authorization_boundary: z.object({
    schema_version: z.literal(1), policy_id: text, decision_ref: text,
    concurrency: z.object({ mode: z.enum(['single-line', 'parallel']), decision_ref: text.nullable() }).strict(),
  }).strict(),
}).strict();

export const executionProtectedIntentSchema = z.object({
  ticket_id: id, destination: requestedExecutionDestinationSchema,
  expected_workflow_revision: z.number().int().positive(), subject_ref: text,
  content_identity: executionContentIdentitySchema,
  comparison: z.object({
    schema_version: z.literal(1), content_identity_sha256: hash, canonical_cwd_sha256: hash,
  }).strict().optional(),
  launch: z.object({
    cwd: z.string().min(1), prompt_sha256: hash, prompt_utf8_bytes: z.number().int().positive(),
    sender: z.string().max(80).nullable(), model: z.string().max(128).nullable(),
    reasoning: z.string().max(128).nullable(), timeout_ms: z.number().int().nullable(),
    permission_selection: z.tuple([
      z.enum(['read-only', 'workspace-write', 'danger-full-access']),
      z.enum(['on-request', 'never']).nullable(),
      z.enum(['user', 'auto_review', 'guardian_subagent']).nullable(),
    ]).nullable(),
  }).strict(),
  authorization_boundary: executionReserveInputSchema.shape.authorization_boundary,
}).strict();

export const executionStateSchema = z.enum([
  'reserved', 'dispatching', 'started', 'bound', 'failed', 'reconciliation-required',
]);

export const executionRuntimeSchema = z.object({
  request_id: z.string().min(1).max(128), fingerprint: hash.nullable(),
  session_id: id.nullable(), run_id: id.nullable(), status: z.string().min(1).max(64).nullable(),
}).strict();

export const executionOperationSchema = z.object({
  schema_version: z.literal(1), operation_id: id, ticket_id: id,
  request_id: z.string().min(1).max(128), fingerprint_version: z.literal('execution-protected-v1'),
  protected_fingerprint: hash, protected_intent: executionProtectedIntentSchema,
  destination: resolvedExecutionDestinationSchema, state: executionStateSchema,
  revision: z.number().int().positive(), runtime: executionRuntimeSchema,
  binding_id: id.nullable(), dispatch: z.object({
    model: text, reasoning: text, permissions: z.unknown(), observed_workflow_revision: z.number().int().positive(),
    observed_subject_ref: text, observed_content_identity: executionContentIdentitySchema,
  }).strict().nullable(),
  failure: z.object({ code: text, reason: text, reprepare_required: z.boolean() }).strict().nullable(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
}).strict();

export const executionOperationReservedRecordSchema = z.object({
  kind: z.literal('execution_operation_reserved'), operation: executionOperationSchema,
}).strict();
export const executionOperationTransitionedRecordSchema = z.object({
  kind: z.literal('execution_operation_transitioned'), previous_state: executionStateSchema,
  operation: executionOperationSchema,
}).strict();
export const executionOperationBoundRecordSchema = z.object({
  kind: z.literal('execution_operation_bound'), previous_state: z.literal('started'),
  operation: executionOperationSchema,
  binding: z.object({ id, ticket_id: id, conversation_id: id, source_id: id,
    session_id: id, scope: z.literal('run'), run_id: id, attached_at: text }).strict(),
}).strict();

export type RequestedExecutionDestination = z.infer<typeof requestedExecutionDestinationSchema>;
export type ResolvedExecutionDestination = z.infer<typeof resolvedExecutionDestinationSchema>;
export type ExecutionReserveInput = z.infer<typeof executionReserveInputSchema>;
export type ExecutionContentIdentity = z.infer<typeof executionContentIdentitySchema>;
export type ExecutionOperation = z.infer<typeof executionOperationSchema>;
export type ExecutionState = z.infer<typeof executionStateSchema>;
