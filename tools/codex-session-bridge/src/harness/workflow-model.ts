import { z } from 'zod';

const id = z.string().uuid();
const text = z.string().min(1).max(512);
const nullableText = text.nullable();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const workflowPhaseSchema = z.enum(['discovery', 'spec', 'tickets', 'ticket-design', 'implementation', 'review', 'acceptance', 'closeout']);
export const applicabilitySchema = z.enum(['verified', 'stale', 'mismatch', 'unknown', 'not-applicable']);
const actorSchema = z.object({ name: text, method: z.enum(['deterministic', 'agent']) }).strict();

export const workflowArtifactSchema = z.object({
  artifact_id: text, role: z.enum(['checkpoint', 'implementation-notes', 'review-report', 'acceptance-report',
    'closeout-archive', 'closeout-input', 'spec', 'ticket', 'test-report', 'other']),
  kind: z.enum(['file', 'reference']), location: text, revision: hash.nullable(), source_schema: nullableText,
  source: text, observed_at: z.string().datetime().nullable(),
  integrity: z.enum(['observed', 'source-not-provided', 'not-yet-observed', 'collection-failed', 'recording-failed', 'redacted', 'truncated']),
}).strict();

const subjectFileSchema = z.object({ path: text, sha256: hash.nullable() }).strict();
export const workflowSubjectSchema = z.object({
  subject_id: text, fixed_point: nullableText, head: nullableText, scope: z.array(text).max(256),
  staged: z.array(subjectFileSchema).max(256), unstaged: z.array(subjectFileSchema).max(256),
  untracked: z.array(subjectFileSchema).max(256), ticket_ref: text, spec_ref: text,
  standards: z.array(text).max(64), tests: z.array(text).max(128),
}).strict();

const axisSchema = z.object({
  status: z.enum(['pending', 'passed', 'findings', 'incomplete', 'not-applicable']),
  evidence: z.array(text).max(128), reason: nullableText,
}).strict();
const findingRefSchema = z.object({ origin_review_id: text, finding_id: text }).strict();
export const workflowReviewSchema = z.object({
  review_id: text, original_review_id: nullableText, mode: z.enum(['full', 'focused', 'evidence']),
  status: z.enum(['pending', 'passed', 'findings', 'incomplete']), subject_ref: text,
  artifact_refs: z.array(text).max(64), standards: axisSchema, spec: axisSchema,
  finding_refs: z.array(findingRefSchema).max(128), isolated: z.union([z.boolean(), z.literal('unknown')]),
  applicability: applicabilitySchema, reason: nullableText,
}).strict();
export const workflowFindingSchema = z.object({
  origin_review_id: text, finding_id: text,
  status: z.enum(['open', 'fixed', 'fixed-unverified', 'verified']), severity: nullableText, summary: text,
  subject_ref: text, verification_review_id: nullableText, artifact_refs: z.array(text).max(64),
  evidence: z.array(text).max(128), applicability: applicabilitySchema, reason: nullableText,
}).strict();

const acceptanceCriteriaSchema = z.object({
  criteria_ref: text, status: z.enum(['pass', 'fail', 'not-verified']), evidence: z.array(text).max(128), notes: nullableText,
}).strict();
export const workflowAcceptanceSchema = z.object({
  acceptance_id: nullableText, status: z.enum(['not-recorded', 'pending', 'incomplete', 'failed', 'passed']),
  actor: actorSchema, subject_ref: nullableText, criteria: z.array(acceptanceCriteriaSchema).max(128),
  evidence: z.array(text).max(128), evidence_refs: z.array(text).max(64).default([]), execution_refs: z.array(text).max(32),
  applicability: applicabilitySchema, reason: nullableText,
}).strict();
export const workflowCloseoutSchema = z.object({
  status: z.enum(['pending', 'archive-observed', 'consistency-checked']), artifact_refs: z.array(text).max(64),
  evidence: z.array(text).max(128), applicability: applicabilitySchema, reason: nullableText,
}).strict();
export const workflowRuntimeRefSchema = z.object({
  runtime_ref_id: text, kind: z.enum(['codex-run', 'owned-task', 'sync-call', 'release', 'config']),
  session_id: id.nullable(), run_id: id.nullable(), task_id: nullableText, call_id: id.nullable(),
  expected_state: nullableText, source: text,
}).strict();

export const workflowSnapshotSchema = z.object({
  phase: workflowPhaseSchema, actor: actorSchema,
  checkpoint: z.object({
    artifact_id: text, ticket_key: text, worktree: text, branch: nullableText,
    fixed_point: nullableText, head: nullableText, phase: workflowPhaseSchema, schema_version: z.union([z.literal(1), z.literal('unknown')]),
  }).strict(),
  subject: workflowSubjectSchema, artifacts: z.array(workflowArtifactSchema).max(128),
  reviews: z.array(workflowReviewSchema).max(64), findings: z.array(workflowFindingSchema).max(256),
  acceptance: workflowAcceptanceSchema, closeout: workflowCloseoutSchema,
  runtime_refs: z.array(workflowRuntimeRefSchema).max(64),
}).strict().superRefine((snapshot, ctx) => {
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: `duplicate ${label}` });
  };
  const artifactIds = snapshot.artifacts.map(value => value.artifact_id);
  unique(artifactIds, 'artifact_id'); unique(snapshot.reviews.map(value => value.review_id), 'review_id');
  unique(snapshot.runtime_refs.map(value => value.runtime_ref_id), 'runtime_ref_id');
  unique(snapshot.findings.map(value => `${value.origin_review_id}:${value.finding_id}`), 'finding identity');
  const artifactSet = new Set(artifactIds), reviewSet = new Set(snapshot.reviews.map(value => value.review_id));
  const runtimeSet = new Set(snapshot.runtime_refs.map(value => value.runtime_ref_id));
  const runtimeById = new Map(snapshot.runtime_refs.map(value => [value.runtime_ref_id, value]));
  const checkpoint = snapshot.artifacts.find(value => value.artifact_id === snapshot.checkpoint.artifact_id);
  if (!checkpoint || checkpoint.role !== 'checkpoint') ctx.addIssue({ code: 'custom', message: 'checkpoint artifact missing' });
  if (snapshot.phase !== snapshot.checkpoint.phase) ctx.addIssue({ code: 'custom', message: 'phase conflicts with checkpoint' });
  for (const review of snapshot.reviews) {
    if (review.mode === 'focused' && (!review.original_review_id || !review.finding_refs.length)) ctx.addIssue({ code: 'custom', message: 'focused review linkage missing' });
    if (review.original_review_id && !reviewSet.has(review.original_review_id)) ctx.addIssue({ code: 'custom', message: 'original review missing' });
    if (review.artifact_refs.some(value => !artifactSet.has(value))) ctx.addIssue({ code: 'custom', message: 'review artifact missing' });
    if (review.status === 'passed' && [review.standards, review.spec].some(axis => !['passed', 'not-applicable'].includes(axis.status))) {
      ctx.addIssue({ code: 'custom', message: 'passed review has an incomplete axis' });
    }
    if (review.status === 'findings' && !review.finding_refs.length) ctx.addIssue({ code: 'custom', message: 'review findings missing' });
  }
  for (const finding of snapshot.findings) {
    if (!reviewSet.has(finding.origin_review_id)) ctx.addIssue({ code: 'custom', message: 'finding origin review missing' });
    if (finding.verification_review_id && !reviewSet.has(finding.verification_review_id)) ctx.addIssue({ code: 'custom', message: 'finding verification review missing' });
    if (finding.status === 'verified' && !finding.verification_review_id) ctx.addIssue({ code: 'custom', message: 'verified finding lacks fresh review' });
    const verification = finding.verification_review_id ? snapshot.reviews.find(value => value.review_id === finding.verification_review_id) : undefined;
    if (finding.status === 'verified' && (!verification || verification.mode !== 'focused' || verification.status !== 'passed'
      || verification.applicability !== 'verified' || !verification.finding_refs.some(value => value.origin_review_id === finding.origin_review_id && value.finding_id === finding.finding_id))) {
      ctx.addIssue({ code: 'custom', message: 'verified finding lacks an applicable focused review' });
    }
    const origin = snapshot.reviews.find(value => value.review_id === finding.origin_review_id);
    if (origin && !origin.finding_refs.some(value => value.origin_review_id === finding.origin_review_id && value.finding_id === finding.finding_id)) {
      ctx.addIssue({ code: 'custom', message: 'finding missing from origin review' });
    }
    if (finding.artifact_refs.some(value => !artifactSet.has(value))) ctx.addIssue({ code: 'custom', message: 'finding artifact missing' });
  }
  if (snapshot.acceptance.actor.method === 'deterministic' && snapshot.acceptance.execution_refs.length) {
    ctx.addIssue({ code: 'custom', message: 'deterministic acceptance cannot claim an agent execution' });
  }
  if (snapshot.acceptance.actor.method === 'agent' && !snapshot.acceptance.execution_refs.length) {
    ctx.addIssue({ code: 'custom', message: 'agent acceptance requires actual execution references' });
  }
  if (snapshot.acceptance.evidence_refs.some(value => !runtimeSet.has(value))) ctx.addIssue({ code: 'custom', message: 'acceptance evidence reference missing' });
  if (snapshot.acceptance.execution_refs.some(value => !runtimeSet.has(value))) ctx.addIssue({ code: 'custom', message: 'acceptance execution reference missing' });
  if (snapshot.acceptance.actor.method === 'agent' && snapshot.acceptance.execution_refs.some(value => {
    const reference = runtimeById.get(value);
    return !reference || reference.kind !== 'codex-run' || !reference.session_id || !reference.run_id;
  })) ctx.addIssue({ code: 'custom', message: 'agent acceptance requires Codex session/run references' });
  if (snapshot.acceptance.status === 'passed' && (!snapshot.acceptance.criteria.length
    || snapshot.acceptance.criteria.some(value => value.status !== 'pass' || !value.evidence.length))) {
    ctx.addIssue({ code: 'custom', message: 'passed acceptance requires evidence for every criterion' });
  }
  if (snapshot.closeout.artifact_refs.some(value => !artifactSet.has(value))) ctx.addIssue({ code: 'custom', message: 'closeout artifact missing' });
  if (snapshot.closeout.status !== 'pending' && (!snapshot.closeout.artifact_refs.length || !snapshot.closeout.evidence.length)) {
    ctx.addIssue({ code: 'custom', message: 'closeout requires artifacts and evidence' });
  }
});

export const workflowRecordInputSchema = z.object({
  ticket_id: id, request_id: z.string().min(1).max(128), expected_revision: z.number().int().nonnegative().nullable(),
  schema_version: z.literal(1), snapshot: workflowSnapshotSchema,
}).strict();

const assessmentReasonSchema = z.object({
  state: applicabilitySchema, code: text, source: text, detail: nullableText,
}).strict();
const artifactAssessmentSchema = z.object({
  artifact_id: text, state: applicabilitySchema, reason: text, checked_at: z.string().datetime(), observed_revision: hash.nullable(),
}).strict();
const runtimeAssessmentSchema = z.object({
  runtime_ref_id: text, state: applicabilitySchema, reason: text, checked_at: z.string().datetime(), observed_state: nullableText,
}).strict();
export const workflowAssessmentSchema = z.object({
  state: applicabilitySchema, checked_at: z.string().datetime(), reasons: z.array(assessmentReasonSchema),
  artifacts: z.array(artifactAssessmentSchema), runtime: z.array(runtimeAssessmentSchema),
}).strict();

export const workflowSnapshotRecordSchema = z.object({
  ticket_id: id, conversation_id: id, workflow_revision: z.number().int().positive(),
  previous_revision: z.number().int().nonnegative().nullable(), request_id: text, fingerprint: hash,
  snapshot: workflowSnapshotSchema, assessment: workflowAssessmentSchema,
}).strict();
export const workflowObservationRecordSchema = z.object({
  ticket_id: id, conversation_id: id, workflow_revision: z.number().int().positive(),
  subject_ref: text, assessment: workflowAssessmentSchema,
}).strict();

export type WorkflowRecordInput = z.infer<typeof workflowRecordInputSchema>;
export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>;
export type WorkflowAssessment = z.infer<typeof workflowAssessmentSchema>;
export type WorkflowSnapshotRecord = z.infer<typeof workflowSnapshotRecordSchema>;
export type WorkflowObservationRecord = z.infer<typeof workflowObservationRecordSchema>;
