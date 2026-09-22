import path from 'node:path';
import type { Harness } from '../harness/harness.ts';
import { HarnessError } from '../harness/model.ts';
import type { Binding, SourceRun } from '../harness/model.ts';
import type { WorkflowSnapshotRecord } from '../harness/workflow-model.ts';
import type { ContextFacts, ContextFactsSource, DocumentFact, SourceFact } from './context-contract.ts';
import { MarkdownContextDocumentAdapter } from './document-adapter.ts';

const activeStatuses = new Set(['queued', 'starting', 'running', 'stopping']);
const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'timed_out', 'interrupted']);
const source = (value: SourceFact) => value;
const docSource = (id: string, kind: SourceFact['kind'], fact: DocumentFact): SourceFact => source({ id, kind,
  locator: fact.location, revision: null, digest: fact.digest, observed_at: fact.observed_at, state: fact.status });
const keyFromTicket = (key: string) => /^[A-Za-z0-9_-]{1,80}/.exec(key.trim())?.[0] ?? '';

export class HarnessContextFactsSource implements ContextFactsSource {
  harness: Harness;
  documents: MarkdownContextDocumentAdapter;
  constructor(harness: Harness, documents = new MarkdownContextDocumentAdapter()) {
    this.harness = harness; this.documents = documents;
  }

  collect(ticketId: string): ContextFacts {
    const ticket = this.harness.tickets.get(ticketId);
    if (!ticket) throw new HarnessError('TICKET_NOT_FOUND');
    const project = this.harness.projects.get(ticket.project_id);
    if (!project) throw new HarnessError('TICKET_NOT_FOUND');
    const registration = this.harness.journal.records.find(record => record.data.kind === 'registered' && record.data.ticket.id === ticketId);
    const ticketRef = source({ id: 'ticket', kind: 'ticket', locator: ticket.reference, revision: registration?.cursor ?? null,
      digest: null, observed_at: registration?.observed_at ?? null, state: 'observed' });
    const root = ticket.comparison_baseline?.worktree_root ?? ticket.expected_worktree;
    const normalizedKey = keyFromTicket(ticket.key);
    const checkpointLocation = normalizedKey ? `.local/workflow-state/${normalizedKey}.md` : '.local/workflow-state/(unavailable)';
    const notesLocation = normalizedKey ? `docs/implementation-notes/${normalizedKey}.md` : 'docs/implementation-notes/(unavailable)';
    const checkpoint = root ? this.documents.read(root, checkpointLocation, 'checkpoint')
      : { ...this.emptyReference(checkpointLocation), status: 'missing' as const };
    const notes = root ? this.documents.read(root, notesLocation, 'implementation-notes')
      : { ...this.emptyReference(notesLocation), status: 'missing' as const };

    let identity: ContextFacts['identity'];
    let gitRef: SourceFact;
    try {
      if (!ticket.comparison_baseline) throw new Error('baseline unavailable');
      const current = this.harness.changes.facts.currentIdentity(ticket.comparison_baseline);
      gitRef = source({ id: 'git', kind: 'git', locator: current.scope.worktree_root, revision: current.payload.head,
        digest: current.digest, observed_at: current.observed_at, state: 'observed' });
      identity = { kind: 'git', scheme: current.scheme, version: current.version, scope: current.scope,
        completeness: current.completeness, digest: current.digest, payload: current.payload, gaps: current.gaps, source_refs: ['git'] };
    } catch {
      const observedAt = new Date().toISOString();
      gitRef = source({ id: 'git', kind: 'git', locator: root ?? 'unavailable', revision: null, digest: null,
        observed_at: observedAt, state: 'unavailable' });
      identity = { kind: 'git', scheme: 'yuki-git-subject', version: 1, scope: null, completeness: 'incomplete', digest: null,
        payload: { head: null, index: [], worktree: [], untracked: [] }, gaps: [{ code: 'GIT_UNAVAILABLE' }], source_refs: ['git'] };
    }

    const workflowRecord = this.harness.workflowHistory.current.get(ticketId);
    const workflowEntry = workflowRecord && this.harness.journal.records.find(record => record.data.kind === 'workflow_snapshot'
      && record.data.workflow.ticket_id === ticketId && record.data.workflow.workflow_revision === workflowRecord.workflow_revision);
    const assessment = workflowRecord ? this.harness.workflowHistory.assessments.get(ticketId) ?? workflowRecord.assessment : null;
    const workflowRef = source({ id: 'workflow', kind: 'workflow', locator: `harness:${ticketId}:workflow`,
      revision: workflowRecord?.workflow_revision ?? null, digest: workflowRecord ? `sha256:${workflowRecord.fingerprint}` : null,
      observed_at: assessment?.checked_at ?? workflowEntry?.observed_at ?? null, state: workflowRecord ? 'observed' : 'missing' });
    const workflow = workflowRecord ? this.projectWorkflow(workflowRecord, assessment?.state ?? 'unknown') : null;

    const runtimeRef = source({ id: 'runtime', kind: 'runtime', locator: `harness:${ticketId}:bindings`,
      revision: this.harness.journal.records.length, digest: null, observed_at: this.harness.checkedAt, state: 'observed' });
    const execution = this.execution(ticketId, workflowRecord, runtimeRef.id);
    const recordingHealth = this.harness.health();
    const harnessRef = source({ id: 'harness', kind: 'harness', locator: `harness:${this.harness.journal.sourceId}`,
      revision: this.harness.journal.records.length, digest: null, observed_at: recordingHealth.observed_at, state: 'observed' });
    const checkpointRef = docSource('checkpoint', 'checkpoint', checkpoint);
    const notesRef = docSource('implementation-notes', 'implementation-notes', notes);
    const specReference = workflowRecord?.snapshot.subject.spec_ref ?? 'GitHub #89';
    return {
      project: { id: project.id, key: project.key, name: project.name, source_refs: ['ticket'] },
      ticket: { id: ticket.id, key: ticket.key, title: ticket.title, reference: ticket.reference, source_refs: ['ticket'] },
      baseline: { fixed_point: ticket.comparison_baseline?.commit_oid ?? null, source_refs: ['ticket', 'git'] },
      identity, workflow, checkpoint, implementation_notes: notes, execution,
      recording: { state: recordingHealth.state, reason: recordingHealth.reason, source_refs: ['harness'] },
      references: [
        { kind: 'ticket', location: ticket.reference, status: 'reference-only', source_refs: ['ticket'] },
        { kind: 'spec', location: specReference, status: 'reference-only', source_refs: ['workflow'] },
      ],
      sources: [ticketRef, gitRef, workflowRef, checkpointRef, notesRef, runtimeRef, harnessRef],
    };
  }

  private emptyReference(location: string): DocumentFact {
    return { status: 'reference-only', adapter: 'markdown-context-v0', location, digest: null, observed_at: null,
      fields: {}, context_plan: null, declarations: { unknown_side_effects: [], next_action: [] } };
  }

  private projectWorkflow(record: WorkflowSnapshotRecord, assessment: string): NonNullable<ContextFacts['workflow']> {
    const snapshot = record.snapshot;
    const reviewPolicy = (snapshot as unknown as { review_policy?: string }).review_policy ?? null;
    return { revision: record.workflow_revision, phase: snapshot.phase, assessment,
      legacy_subject: { scheme: 'legacy-workflow-subject', subject_id: snapshot.subject.subject_id,
        fixed_point: snapshot.subject.fixed_point, head: snapshot.subject.head, scope: snapshot.subject.scope },
      findings: snapshot.findings.map(value => ({ origin_review_id: value.origin_review_id, finding_id: value.finding_id,
        status: value.status, severity: value.severity, summary: value.summary, applicability: value.applicability,
        source_refs: ['workflow'] })), review_policy: reviewPolicy, source_refs: ['workflow'] };
  }

  private execution(ticketId: string, workflow: WorkflowSnapshotRecord | undefined, sourceRef: string): ContextFacts['execution'] {
    const bindings = [...this.harness.bindings.values()].filter(binding => binding.ticket_id === ticketId);
    const observed: ContextFacts['execution']['observed'] = [];
    const seen = new Set<string>(); let complete = true;
    const addRun = (run: SourceRun, binding: Binding | null, runtimeRefId: string | null) => {
      if (seen.has(run.id)) return; seen.add(run.id);
      const classification = activeStatuses.has(run.status) ? 'active' : terminalStatuses.has(run.status) ? 'terminal' : 'unknown';
      if (classification === 'unknown') complete = false;
      observed.push({ session_id: run.session_id, run_id: run.id, status: run.status, classification,
        model: run.model, reasoning: run.reasoning, binding_id: binding?.id ?? null, runtime_ref_id: runtimeRefId,
        observed_at: run.finished_at ?? run.started_at ?? run.created_at, source_refs: [sourceRef] });
    };
    for (const binding of bindings) {
      try {
        const runs = this.harness.source.runs(binding.session_id).filter(run => binding.scope === 'session' || run.id === binding.run_id);
        if (!runs.length) complete = false;
        for (const run of runs) addRun(run, binding, null);
      } catch { complete = false; }
    }
    const runtimeRefs = workflow?.snapshot.runtime_refs ?? [];
    for (const reference of runtimeRefs) {
      if (reference.kind !== 'codex-run' || !reference.session_id || !reference.run_id || seen.has(reference.run_id)) continue;
      try {
        const run = this.harness.source.runs(reference.session_id).find(value => value.id === reference.run_id);
        if (run) addRun(run, null, reference.runtime_ref_id); else complete = false;
      } catch { complete = false; }
    }
    observed.sort((left, right) => String(left.run_id).localeCompare(String(right.run_id)));
    return { observed, coverage: { bindings: bindings.length, workflow_runtime_refs: runtimeRefs.length,
      global: false, complete }, source_refs: [sourceRef, ...(workflow ? ['workflow'] : [])] };
  }
}
