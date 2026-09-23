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

const executionReserveV1InputSchema = z.object({
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

export const implementationLaunchContractSchema = z.object({
  schema_version: z.literal(1), kind: z.literal('ticket-implementation'),
  review_policy: z.literal('delegated'), destination: z.literal('main'), session: z.literal('fresh'),
}).strict();

export const implementationPolicySnapshotSchema = z.object({
  schema_version: z.literal(1), policy_id: text, revision: z.number().int().positive(), digest: hash,
  project_key: text, action: z.literal('ticket-implementation'), workflow_phase: z.literal('implementation'),
  supported_contract_versions: z.array(z.number().int().positive()).min(1).max(16),
  model: text, reasoning: text, permission_selection: z.literal('owner-native-default'),
  preflight: z.object({
    required_paths: z.array(text).max(64), required_executables: z.array(text).max(64),
    dependency_packages: z.array(text).max(16).optional(),
    require_recording: z.literal(true), model_line: z.literal('single'),
  }).strict(),
  authority_refs: z.array(text).min(1).max(32),
}).strict();

export const implementationAuthorizationSchema = z.object({
  schema_version: z.literal(1), authorization_id: text, ticket_key: text,
  action: z.literal('ticket-implementation'), endpoint: z.literal('implementation'), contract_version: z.literal(1),
  authorization_ref: text, notes: z.object({ path: text, sha256: hash }).strict(),
  authority_refs: z.array(text).min(1).max(32),
}).strict();

export const implementationAuthoritySourceIdentitySchema = z.object({
  schema_version: z.literal(1), kind: z.enum(['file', 'adapter']), reference: text,
  canonical_path: z.string().min(1).nullable(), sha256: hash,
}).strict();

export const implementationExecutableIdentitySchema = z.object({
  schema_version: z.literal(1), name: text, canonical_path: z.string().min(1), sha256: hash,
  source: z.literal('host-path'), refresh: z.literal('preflight-and-dispatch-guard'),
}).strict();

const implementationEnvironmentSnapshotSchema = z.union([
  z.object({ required_paths: z.array(text).max(64), required_executables: z.array(text).max(64) }).strict(),
  z.object({ required_paths: z.array(text).max(64),
    required_executables: z.array(implementationExecutableIdentitySchema).max(64),
    dependencies: z.array(z.object({ package_directory: text, manifest_sha256: hash, lock_sha256: hash.nullable(),
      modules_mtime_ms: z.number().nullable(), node_path: text, node_version: text }).strict()).max(16).optional(),
    capabilities: z.object({ path_digest: hash, rg_state: z.enum(['available', 'unavailable']),
      rg_path: z.string().nullable(), rg_version: z.string().nullable(),
      fallbacks: z.array(z.string()).max(2) }).strict().optional() }).strict(),
]);

const deltaSchema = z.object({ ref: text, value: z.string().max(2048).nullable() }).strict();
export const implementationExecutionProtectionSchema = z.object({
  caller_fingerprint: hash, contract: implementationLaunchContractSchema,
  policy: implementationPolicySnapshotSchema, authorization: implementationAuthorizationSchema,
  authority_source: implementationAuthoritySourceIdentitySchema.optional(),
  prompt_context: z.object({ references: z.array(text).min(1).max(64), current_delta: z.array(deltaSchema).max(32),
    cost: z.object({ prompt_utf8_bytes: z.number().int().nonnegative(), reference_count: z.number().int().nonnegative(),
      duplicate_reference_count: z.number().int().nonnegative() }).strict().optional() }).strict(),
  preflight: z.object({
    workflow_revision: z.number().int().positive(), subject_ref: text,
    notes: z.object({ path: text, sha256: hash }).strict(),
    environment: implementationEnvironmentSnapshotSchema,
  }).strict(),
}).strict();

export const executionReserveV2InputSchema = executionReserveV1InputSchema.extend({
  implementation: implementationExecutionProtectionSchema,
}).strict();
export const executionReserveInputSchema = z.union([executionReserveV1InputSchema, executionReserveV2InputSchema]);

const executionProtectedIntentV1Schema = z.object({
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
  authorization_boundary: executionReserveV1InputSchema.shape.authorization_boundary,
}).strict();
export const executionProtectedIntentSchema = z.union([
  executionProtectedIntentV1Schema,
  executionProtectedIntentV1Schema.extend({ implementation: implementationExecutionProtectionSchema }).strict(),
]);

export const executionStateSchema = z.enum([
  'reserved', 'dispatching', 'started', 'bound', 'failed', 'reconciliation-required',
]);

export const executionRuntimeSchema = z.object({
  request_id: z.string().min(1).max(128), fingerprint: hash.nullable(),
  session_id: id.nullable(), run_id: id.nullable(), status: z.string().min(1).max(64).nullable(),
}).strict();

const executionOperationCommon = {
  operation_id: id, ticket_id: id, request_id: z.string().min(1).max(128),
  protected_fingerprint: hash, destination: resolvedExecutionDestinationSchema, state: executionStateSchema,
  revision: z.number().int().positive(), runtime: executionRuntimeSchema,
  binding_id: id.nullable(), dispatch: z.object({
    model: text, reasoning: text, permissions: z.unknown(), observed_workflow_revision: z.number().int().positive(),
    observed_subject_ref: text, observed_content_identity: executionContentIdentitySchema,
  }).strict().nullable(),
  failure: z.object({ code: text, reason: text, reprepare_required: z.boolean() }).strict().nullable(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
};
const executionOperationV1Schema = z.object({
  schema_version: z.literal(1), operation_id: id, ticket_id: id,
  request_id: z.string().min(1).max(128), fingerprint_version: z.literal('execution-protected-v1'),
  protected_fingerprint: hash, protected_intent: executionProtectedIntentV1Schema,
  destination: resolvedExecutionDestinationSchema, state: executionStateSchema,
  revision: z.number().int().positive(), runtime: executionRuntimeSchema,
  binding_id: id.nullable(), dispatch: executionOperationCommon.dispatch,
  failure: executionOperationCommon.failure, created_at: executionOperationCommon.created_at,
  updated_at: executionOperationCommon.updated_at,
}).strict();
const executionProtectedIntentV2Schema = executionProtectedIntentV1Schema.extend({
  implementation: implementationExecutionProtectionSchema,
}).strict();
const executionOperationV2Schema = z.object({ ...executionOperationCommon,
  schema_version: z.literal(2), fingerprint_version: z.literal('execution-protected-v2'),
  protected_intent: executionProtectedIntentV2Schema,
}).strict();
export const executionOperationSchema = z.union([executionOperationV1Schema, executionOperationV2Schema]);

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
