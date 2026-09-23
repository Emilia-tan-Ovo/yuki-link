import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { protectedCopy } from './content-policy.ts';
import { HarnessError } from './model.ts';
import type { Journal } from './journal.ts';
import type { RecordEntry, Ticket } from './model.ts';
import { workflowRecordInputSchema } from './workflow-model.ts';
import type { WorkflowAssessment, WorkflowRecordInput, WorkflowSnapshotRecord } from './workflow-model.ts';
import { WorkflowPathError, WorkflowSource } from './workflow-source.ts';
import type { WorkflowValidationIssue } from './workflow-source.ts';

// These messages are emitted by workflowSnapshotSchema.superRefine. Keep the public
// reason/path vocabulary explicit so future messages cannot expose caller data.
const relationIssues: Record<string, { path: string; reason: string }> = {
  'duplicate artifact_id': { path: 'snapshot.artifacts', reason: 'DUPLICATE_ARTIFACT_ID' },
  'duplicate review_id': { path: 'snapshot.reviews', reason: 'DUPLICATE_REVIEW_ID' },
  'duplicate runtime_ref_id': { path: 'snapshot.runtime_refs', reason: 'DUPLICATE_RUNTIME_REF_ID' },
  'duplicate finding identity': { path: 'snapshot.findings', reason: 'DUPLICATE_FINDING_IDENTITY' },
  'duplicate review participant': { path: 'snapshot.reviews', reason: 'DUPLICATE_REVIEW_PARTICIPANT' },
  'duplicate review participant runtime_ref_id': { path: 'snapshot.reviews', reason: 'DUPLICATE_PARTICIPANT_RUNTIME_REF_ID' },
  'checkpoint artifact missing': { path: 'snapshot.checkpoint.artifact_id', reason: 'CHECKPOINT_ARTIFACT_MISSING' },
  'phase conflicts with checkpoint': { path: 'snapshot.checkpoint.phase', reason: 'PHASE_MISMATCH' },
  'focused review linkage missing': { path: 'snapshot.reviews', reason: 'FOCUSED_REVIEW_LINKAGE_MISSING' },
  'original review missing': { path: 'snapshot.reviews', reason: 'ORIGINAL_REVIEW_MISSING' },
  'review artifact missing': { path: 'snapshot.reviews', reason: 'REVIEW_ARTIFACT_MISSING' },
  'passed review has an incomplete axis': { path: 'snapshot.reviews', reason: 'REVIEW_AXIS_INCOMPLETE' },
  'review findings missing': { path: 'snapshot.reviews', reason: 'REVIEW_FINDINGS_MISSING' },
  'review execution reference missing': { path: 'snapshot.reviews', reason: 'REVIEW_EXECUTION_REF_MISSING' },
  'review requires Codex session/run references': { path: 'snapshot.reviews', reason: 'REVIEW_CODEX_RUN_REF_REQUIRED' },
  'review participant execution reference missing': { path: 'snapshot.reviews', reason: 'PARTICIPANT_EXECUTION_REF_MISSING' },
  'review participant requires Codex session/run reference': { path: 'snapshot.reviews', reason: 'PARTICIPANT_CODEX_RUN_REF_REQUIRED' },
  'finding origin review missing': { path: 'snapshot.findings', reason: 'FINDING_ORIGIN_REVIEW_MISSING' },
  'finding verification review missing': { path: 'snapshot.findings', reason: 'FINDING_VERIFICATION_REVIEW_MISSING' },
  'verified finding lacks fresh review': { path: 'snapshot.findings', reason: 'FINDING_FRESH_REVIEW_MISSING' },
  'verified finding lacks an applicable focused review': { path: 'snapshot.findings', reason: 'FINDING_FOCUSED_REVIEW_INVALID' },
  'finding missing from origin review': { path: 'snapshot.findings', reason: 'FINDING_NOT_IN_ORIGIN_REVIEW' },
  'finding artifact missing': { path: 'snapshot.findings', reason: 'FINDING_ARTIFACT_MISSING' },
  'deterministic acceptance cannot claim an agent execution': { path: 'snapshot.acceptance.execution_refs', reason: 'DETERMINISTIC_AGENT_EXECUTION' },
  'agent acceptance requires actual execution references': { path: 'snapshot.acceptance.execution_refs', reason: 'AGENT_EXECUTION_REF_MISSING' },
  'acceptance evidence reference missing': { path: 'snapshot.acceptance.evidence_refs', reason: 'ACCEPTANCE_EVIDENCE_REF_MISSING' },
  'acceptance execution reference missing': { path: 'snapshot.acceptance.execution_refs', reason: 'ACCEPTANCE_EXECUTION_REF_MISSING' },
  'agent acceptance requires Codex session/run references': { path: 'snapshot.acceptance.execution_refs', reason: 'ACCEPTANCE_CODEX_RUN_REF_REQUIRED' },
  'passed acceptance requires evidence for every criterion': { path: 'snapshot.acceptance.criteria', reason: 'ACCEPTANCE_CRITERION_EVIDENCE_MISSING' },
  'closeout artifact missing': { path: 'snapshot.closeout.artifact_refs', reason: 'CLOSEOUT_ARTIFACT_MISSING' },
  'closeout requires artifacts and evidence': { path: 'snapshot.closeout', reason: 'CLOSEOUT_EVIDENCE_MISSING' },
};

const schemaIssues = (error: ZodError): WorkflowValidationIssue[] => error.issues.slice(0, 8).map(issue => {
  // Only schema property names and array offsets enter diagnostics. Never use Zod messages,
  // received values, unrecognized key lists or caller supplied paths.
  const segments = issue.path.slice(0, 12).map(part => typeof part === 'number' ? `[${part}]`
    : /^[a-z_][a-z0-9_]{0,39}$/.test(String(part)) ? String(part) : 'field');
  const path = segments.reduce((value, part) => value + (part.startsWith('[') ? part : `${value ? '.' : ''}${part}`), '') || 'input';
  const relation = issue.code === 'custom' ? relationIssues[issue.message] : undefined;
  const safePath = relation?.path ?? path;
  const field = relation ? safePath.split('.').at(-1)! : [...segments].reverse().find(part => !part.startsWith('[')) ?? 'input';
  const reason = /^[a-z_]+$/.test(issue.code) ? issue.code.toUpperCase() : 'INVALID_FIELD';
  return { field, path: safePath, reason: relation?.reason ?? reason };
});

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const subjectIdentity = (subject: WorkflowSnapshotRecord['snapshot']['subject']) => {
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const files = (values: typeof subject.staged) => values
    .map(file => ({ path: file.path.replaceAll('\\', '/'), sha256: file.sha256 }))
    .sort((left, right) => compare(left.path, right.path) || compare(left.sha256 ?? '', right.sha256 ?? ''));
  if (subject.head === null || [...subject.staged, ...subject.unstaged, ...subject.untracked].some(file => file.sha256 === null)) return null;
  return digest({ head: subject.head, staged: files(subject.staged), unstaged: files(subject.unstaged), untracked: files(subject.untracked) });
};
const comparable = (assessment: WorkflowAssessment) => JSON.stringify({ ...assessment, checked_at: null,
  reasons: assessment.reasons.map(reason => ({ ...reason })), artifacts: assessment.artifacts.map(value => ({ ...value, checked_at: null })),
  runtime: assessment.runtime.map(value => ({ ...value, checked_at: null })) });

export class WorkflowHistory {
  journal: Journal;
  ticket: (id: string) => Ticket;
  source: WorkflowSource;
  current = new Map<string, WorkflowSnapshotRecord>();
  requests = new Map<string, WorkflowSnapshotRecord>();
  assessments = new Map<string, WorkflowAssessment>();
  constructor(journal: Journal, ticket: (id: string) => Ticket, source: WorkflowSource) {
    this.journal = journal; this.ticket = ticket; this.source = source;
    for (const record of journal.records) this.apply(record);
  }
  apply(record: RecordEntry) {
    if (record.data.kind === 'workflow_snapshot') {
      const value = record.data.workflow;
      this.current.set(value.ticket_id, value); this.requests.set(value.ticket_id + ':' + value.request_id, value);
      this.assessments.set(value.ticket_id, value.assessment);
    } else if (record.data.kind === 'workflow_observation') this.assessments.set(record.data.workflow.ticket_id, record.data.workflow.assessment);
  }
  private receipt(record: WorkflowSnapshotRecord, entry: RecordEntry, deduplicated: boolean) {
    return { workflow_revision: record.workflow_revision, event_id: entry.event_id, cursor: entry.cursor, deduplicated,
      applicability: this.assessments.get(record.ticket_id) ?? record.assessment, observed_at: entry.observed_at,
      recording: { state: this.journal.failure ? 'recording-failed' : 'recording', reason: this.journal.failure,
        source_id: this.journal.sourceId, source: 'structured-workflow-evidence' } };
  }
  record(input: unknown) {
    let parsed: WorkflowRecordInput;
    try {
      const size = Buffer.byteLength(JSON.stringify(input), 'utf8');
      if (size > 64 * 1024) throw new HarnessError('INVALID_WORKFLOW_RECORD', {
        issues: [{ field: 'input', path: 'input', reason: 'PAYLOAD_TOO_LARGE' }],
      });
      const first = workflowRecordInputSchema.parse(input);
      parsed = workflowRecordInputSchema.parse(protectedCopy(first).value);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('INVALID_WORKFLOW_RECORD', { issues: error instanceof ZodError
        ? schemaIssues(error) : [{ field: 'input', path: 'input', reason: 'INVALID_PAYLOAD' }] });
    }
    const ticket = this.ticket(parsed.ticket_id);
    const fingerprint = digest(parsed);
    const requestKey = parsed.ticket_id + ':' + parsed.request_id;
    const prior = this.requests.get(requestKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HarnessError('REQUEST_CONFLICT');
      const entry = this.journal.records.find(record => record.data.kind === 'workflow_snapshot'
        && record.data.workflow.ticket_id === prior.ticket_id && record.data.workflow.workflow_revision === prior.workflow_revision)!;
      return this.receipt(prior, entry, true);
    }
    if (parsed.snapshot.subject.ticket_ref !== ticket.reference) throw new HarnessError('ATTRIBUTION_MISMATCH');
    try { this.source.validate(ticket, parsed.snapshot); }
    catch (error) { throw new HarnessError('INVALID_WORKFLOW_RECORD', { issues: error instanceof WorkflowPathError
      ? error.issues : [{ field: 'snapshot', path: 'snapshot', reason: 'INVALID_PATH' }] }); }
    const previous = this.current.get(parsed.ticket_id);
    const expected = previous?.workflow_revision ?? null;
    if (parsed.expected_revision !== expected) throw new HarnessError('WORKFLOW_REVISION_CONFLICT', { expected_revision: expected });
    const assessment = this.source.assess(ticket, parsed.snapshot);
    const workflow: WorkflowSnapshotRecord = { ticket_id: ticket.id, conversation_id: ticket.main_conversation_id,
      workflow_revision: (previous?.workflow_revision ?? 0) + 1, previous_revision: previous?.workflow_revision ?? null,
      request_id: parsed.request_id, fingerprint, snapshot: parsed.snapshot, assessment };
    const entry = this.journal.append({ kind: 'workflow_snapshot', workflow });
    this.apply(entry);
    return this.receipt(workflow, entry, false);
  }
  scan() {
    if (this.journal.failure) return;
    for (const [ticketId, workflow] of this.current) {
      const assessment = this.source.assess(this.ticket(ticketId), workflow.snapshot);
      const previous = this.assessments.get(ticketId) ?? workflow.assessment;
      if (comparable(assessment) !== comparable(previous)) {
        try {
          const entry = this.journal.append({ kind: 'workflow_observation', workflow: { ticket_id: ticketId,
            conversation_id: workflow.conversation_id, workflow_revision: workflow.workflow_revision,
            subject_ref: workflow.snapshot.subject.subject_id, assessment } });
          this.apply(entry);
        } catch { if (this.journal.failure) return; throw new HarnessError('RECORDING_FAILED'); }
      } else this.assessments.set(ticketId, assessment);
    }
  }
  summary(ticketId: string) {
    const record = this.current.get(ticketId);
    if (!record) return { state: 'unavailable', reason: 'not-yet-observed' };
    const snapshot = record.snapshot, assessment = this.assessments.get(ticketId) ?? record.assessment;
    const currentSubject = snapshot.subject.subject_id;
    const currentIdentity = subjectIdentity(snapshot.subject);
    const terminalReview = (review: typeof snapshot.reviews[number]) => !['pending', 'incomplete'].includes(review.status)
      && review.applicability === 'verified'
      && [review.standards, review.spec].every(axis => !['pending', 'incomplete'].includes(axis.status));
    const terminalReviews = snapshot.reviews.filter(review => (review.mode === 'full' || review.mode === 'evidence')
      && terminalReview(review));
    const fullReviews = terminalReviews.filter(review => review.mode === 'full');
    const reviewGate = currentIdentity !== null && (snapshot.findings.length === 0
      ? terminalReviews.some(review => review.status === 'passed' && review.subject_ref === currentSubject
        && review.subject_identity === currentIdentity)
      : fullReviews.length > 0 && snapshot.findings.every(finding => {
        const origin = fullReviews.find(review => review.review_id === finding.origin_review_id);
        const verification = snapshot.reviews.find(review => review.review_id === finding.verification_review_id);
        return finding.status === 'verified' && finding.applicability === 'verified' && finding.subject_ref === currentSubject
          && finding.subject_identity === currentIdentity && Boolean(origin?.subject_identity) && Boolean(verification)
          && verification!.mode === 'focused'
          && verification!.original_review_id === finding.origin_review_id && verification!.status === 'passed'
          && verification!.subject_ref === currentSubject && verification!.subject_identity === currentIdentity
          && terminalReview(verification!);
      }));
    const accepted = snapshot.acceptance.status === 'passed' && snapshot.acceptance.applicability === 'verified'
      && assessment.state === 'verified' && snapshot.acceptance.subject_ref === currentSubject
      && snapshot.acceptance.criteria.length > 0 && snapshot.acceptance.criteria.every(value => value.status === 'pass' && value.evidence.length)
      && reviewGate;
    return { revision: record.workflow_revision, phase: snapshot.phase, assessment,
      reviews: snapshot.reviews.map(value => ({ review_id: value.review_id, mode: value.mode, status: value.status, applicability: value.applicability })),
      findings: snapshot.findings.map(value => ({ origin_review_id: value.origin_review_id, finding_id: value.finding_id, status: value.status, applicability: value.applicability })),
      acceptance: { status: snapshot.acceptance.status, applicability: snapshot.acceptance.applicability, accepted },
      closeout: { status: snapshot.closeout.status, applicability: snapshot.closeout.applicability },
      observed_at: assessment.checked_at };
  }
  detail(ticketId: string) {
    const record = this.current.get(ticketId);
    if (!record) return { current: null, history: [] };
    const assessment = this.assessments.get(ticketId) ?? record.assessment;
    const history = this.journal.records.filter(entry => (entry.data.kind === 'workflow_snapshot' || entry.data.kind === 'workflow_observation')
      && entry.data.workflow.ticket_id === ticketId).map(entry => entry.cursor);
    return { current: { ...record.snapshot, revision: record.workflow_revision, previous_revision: record.previous_revision,
      request_id: record.request_id, assessment }, history };
  }
}
