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
  locator: fact.location, revision: null, digest: fact.digest, observed_at: fact.observed_at,
  source_updated_at: fact.source_updated_at, state: fact.status });
const keyFromTicket = (key: string) => /^[A-Za-z0-9_-]{1,80}/.exec(key.trim())?.[0] ?? '';

export class HarnessContextFactsSource implements ContextFactsSource {
  harness: Harness;
  documents: MarkdownContextDocumentAdapter;
  constructor(harness: Harness, documents = new MarkdownContextDocumentAdapter()) {
    this.harness = harness; this.documents = documents;
  }

  collect(ticketId: string): ContextFacts {
    const observedAt = new Date().toISOString();
    const ticket = this.harness.tickets.get(ticketId);
    if (!ticket) throw new HarnessError('TICKET_NOT_FOUND');
    const project = this.harness.projects.get(ticket.project_id);
    if (!project) throw new HarnessError('TICKET_NOT_FOUND');
    const registration = this.harness.journal.records.find(record => record.data.kind === 'registered' && record.data.ticket.id === ticketId);
    const ticketRef = source({ id: 'ticket', kind: 'ticket', locator: ticket.reference, revision: registration?.cursor ?? null,
      digest: null, observed_at: observedAt, source_updated_at: registration?.observed_at ?? null, state: 'observed' });
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
        digest: current.digest, observed_at: current.observed_at, source_updated_at: null, state: 'observed' });
      identity = { kind: 'git', scheme: current.scheme, version: current.version, scope: current.scope,
        completeness: current.completeness, digest: current.digest, payload: current.payload, gaps: current.gaps, source_refs: ['git'] };
    } catch {
      gitRef = source({ id: 'git', kind: 'git', locator: root ?? 'unavailable', revision: null, digest: null,
        observed_at: observedAt, source_updated_at: null, state: 'unavailable' });
      identity = { kind: 'git', scheme: 'yuki-git-subject', version: 1, scope: null, completeness: 'incomplete', digest: null,
        payload: { head: null, index_state: { scheme: 'git-index-entries-v1', digest: null },
          index: [], worktree: [], untracked: [] }, gaps: [{ code: 'GIT_UNAVAILABLE' }], source_refs: ['git'] };
    }

    const workflowRecord = this.harness.workflowHistory.current.get(ticketId);
    const workflowEntry = workflowRecord && this.harness.journal.records.find(record => record.data.kind === 'workflow_snapshot'
      && record.data.workflow.ticket_id === ticketId && record.data.workflow.workflow_revision === workflowRecord.workflow_revision);
    const assessment = workflowRecord ? this.harness.workflowHistory.assessments.get(ticketId) ?? workflowRecord.assessment : null;
    const workflowRef = source({ id: 'workflow', kind: 'workflow', locator: `harness:${ticketId}:workflow`,
      revision: workflowRecord?.workflow_revision ?? null, digest: workflowRecord ? `sha256:${workflowRecord.fingerprint}` : null,
      observed_at: observedAt, source_updated_at: assessment?.checked_at ?? workflowEntry?.observed_at ?? null,
      state: workflowRecord ? 'observed' : 'missing' });
    const workflow = workflowRecord ? this.projectWorkflow(workflowRecord, assessment?.state ?? 'unknown') : null;

    const runtimeRef = source({ id: 'runtime', kind: 'runtime', locator: `harness:${ticketId}:bindings`,
      revision: this.harness.journal.records.length, digest: null, observed_at: observedAt,
      source_updated_at: this.harness.checkedAt, state: 'observed' });
    const execution = this.execution(ticketId, workflowRecord, runtimeRef.id, observedAt);
    const recordingHealth = this.harness.health();
    const harnessRef = source({ id: 'harness', kind: 'harness', locator: `harness:${this.harness.journal.sourceId}`,
      revision: this.harness.journal.records.length, digest: null, observed_at: observedAt,
      source_updated_at: recordingHealth.observed_at, state: 'observed' });
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
      source_updated_at: null, fields: {}, context_plan: null, declarations: { unknown_side_effects: [], next_action: [] } };
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

  private execution(ticketId: string, workflow: WorkflowSnapshotRecord | undefined, sourceRef: string,
    observedAt: string): ContextFacts['execution'] {
    const bindings = [...this.harness.bindings.values()].filter(binding => binding.ticket_id === ticketId);
    const observed: ContextFacts['execution']['observed'] = [];
    const seenBindings = new Set<string>(); let complete = true;
    const classification = (status: string) => activeStatuses.has(status) ? 'active' as const
      : terminalStatuses.has(status) ? 'terminal' as const : 'unknown' as const;
    const addRun = (run: SourceRun, binding: Binding | null, runtimeRefId: string | null) => {
      if (binding && seenBindings.has(run.id)) return;
      if (binding) seenBindings.add(run.id);
      const state = classification(run.status);
      if (state === 'unknown') complete = false;
      observed.push({ runtime_kind: 'codex-run', session_id: run.session_id, run_id: run.id, task_id: null,
        status: run.status, classification: state,
        model: run.model, reasoning: run.reasoning, binding_id: binding?.id ?? null, runtime_ref_id: runtimeRefId,
        observed_at: observedAt, created_at: run.created_at, started_at: run.started_at ?? null,
        finished_at: run.finished_at ?? null, source_refs: [sourceRef] });
    };
    const addUnknown = (reference: WorkflowSnapshotRecord['snapshot']['runtime_refs'][number]) => {
      complete = false;
      observed.push({ runtime_kind: reference.kind, session_id: reference.session_id, run_id: reference.run_id,
        task_id: reference.task_id, call_id: reference.call_id, status: 'unknown', classification: 'unknown',
        model: null, reasoning: null, binding_id: null, runtime_ref_id: reference.runtime_ref_id,
        observed_at: observedAt, created_at: null, started_at: null, finished_at: null, source_refs: [sourceRef, 'workflow'] });
    };
    for (const binding of bindings) {
      try {
        const runs = this.harness.source.runs(binding.session_id).filter(run => binding.scope === 'session' || run.id === binding.run_id);
        if (!runs.length) complete = false;
        for (const run of runs) addRun(run, binding, null);
      } catch { complete = false; }
    }
    const runtimeRefs = workflow?.snapshot.runtime_refs ?? [];
    let ownedTasks: ReturnType<Harness['taskHistory']['currentStatus']> = [];
    if (runtimeRefs.some(reference => reference.kind === 'owned-task')) {
      try { ownedTasks = this.harness.taskHistory.currentStatus(ticketId); } catch { complete = false; }
    }
    for (const reference of runtimeRefs) {
      if (reference.kind === 'codex-run' && reference.session_id && reference.run_id) {
        try {
          const run = this.harness.source.runs(reference.session_id).find(value => value.id === reference.run_id);
          if (run) addRun(run, null, reference.runtime_ref_id); else addUnknown(reference);
        } catch { addUnknown(reference); }
        continue;
      }
      if (reference.kind === 'owned-task' && reference.task_id) {
        const task = ownedTasks.find(value => value.binding.task_id === reference.task_id);
        if (task?.current.state === 'observed' && task.snapshot) {
          const state = classification(task.snapshot.status);
          if (state === 'unknown') complete = false;
          observed.push({ runtime_kind: 'owned-task', session_id: null, run_id: null, task_id: reference.task_id,
            call_id: null, status: task.snapshot.status, classification: state, model: null, reasoning: null,
            binding_id: task.binding.binding_id, runtime_ref_id: reference.runtime_ref_id, observed_at: observedAt,
            created_at: task.snapshot.created_at, started_at: task.snapshot.started_at,
            finished_at: task.snapshot.finished_at, source_refs: [sourceRef, 'workflow'] });
        } else addUnknown(reference);
        continue;
      }
      addUnknown(reference);
    }
    observed.sort((left, right) => String(left.runtime_ref_id ?? left.binding_id ?? left.run_id ?? left.task_id)
      .localeCompare(String(right.runtime_ref_id ?? right.binding_id ?? right.run_id ?? right.task_id)));
    return { observed, coverage: { bindings: bindings.length, workflow_runtime_refs: runtimeRefs.length,
      global: false, complete }, source_refs: [sourceRef, ...(workflow ? ['workflow'] : [])] };
  }
}
