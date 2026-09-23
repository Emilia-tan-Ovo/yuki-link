import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import type { Harness } from '../harness/harness.ts';
import { HarnessError } from '../harness/model.ts';
import type { Binding, SourceRun } from '../harness/model.ts';
import type { WorkflowSnapshotRecord } from '../harness/workflow-model.ts';
import type { ContextFacts, ContextFactsSource, DocumentFact, SourceFact } from './context-contract.ts';
import { MarkdownContextDocumentAdapter } from './document-adapter.ts';
import { inspectDependency, inspectHostCapabilities } from './preflight.ts';
import { targetDependencyPackages } from './implementation-launcher.ts';
import type { ImplementationLaunchAuthoritySource } from './implementation-launcher.ts';

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
  sourceObservations: Map<string, { status: 'observed' | 'unavailable'; revision: string | null;
    observed_at: string; digest: string | null; url?: string; provenance?: string; reason?: string }>;
  authority: ImplementationLaunchAuthoritySource | null;
  constructor(harness: Harness, documents = new MarkdownContextDocumentAdapter(),
    sourceObservations = new Map<string, { status: 'observed' | 'unavailable'; revision: string | null;
      observed_at: string; digest: string | null; url?: string; provenance?: string; reason?: string }>(),
    authority: ImplementationLaunchAuthoritySource | null = null) {
    this.harness = harness; this.documents = documents; this.sourceObservations = sourceObservations;
    this.authority = authority;
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
    const workflowSpecRef = workflowRecord?.snapshot.subject.spec_ref ?? null;
    const notesSpecRef = typeof notes.fields.source_spec_ref === 'string' ? notes.fields.source_spec_ref : null;
    const canonicalSpec = notesSpecRef ?? workflowSpecRef;
    const mirrorLocations = [...new Set([
      ...(workflowSpecRef && /^[.A-Za-z0-9/_-]+\.md$/.test(workflowSpecRef) ? [workflowSpecRef] : []),
      ...(notes.context_plan?.related ?? []).flatMap(value => [...value.matchAll(/docs\/specs?\/[A-Za-z0-9/_-]+\.md/g)].map(match => match[0])),
    ])].slice(0, 16);
    const specSources: SourceFact[] = [];
    const references: ContextFacts['references'] = [
      { kind: 'ticket', location: ticket.reference, status: 'reference-only', source_refs: ['ticket'] },
    ];
    if (canonicalSpec) {
      const external = this.sourceObservations.get(canonicalSpec);
      const externalValid = external && external.url === canonicalSpec
        && typeof external.provenance === 'string' && external.provenance.length > 0
        && external.provenance.length <= 512
        && Number.isFinite(Date.parse(external.observed_at))
        && (external.status === 'unavailable' || Boolean(external.revision
          && /^sha256:[0-9a-f]{64}$/.test(external.digest ?? '')));
      const canonicalStatus = externalValid ? external.status : 'reference-only';
      references.push({ kind: 'spec', location: canonicalSpec, status: canonicalStatus, canonical: true,
        observed_at: externalValid ? external.observed_at : null, revision: externalValid ? external.revision : null,
        source_refs: [notesSpecRef ? 'implementation-notes' : 'workflow', 'spec-canonical'] });
      specSources.push(source({ id: 'spec-canonical', kind: 'spec', locator: canonicalSpec,
        revision: externalValid ? external.revision : null,
        digest: externalValid ? external.digest : null, observed_at: externalValid ? external.observed_at : null,
        source_updated_at: externalValid ? external.observed_at : null, state: canonicalStatus,
        ...(externalValid && external.provenance ? { provenance: external.provenance } : {}),
        ...(externalValid && external.reason ? { reason: external.reason } : {}) }));
    }
    if (notesSpecRef && workflowSpecRef && notesSpecRef !== workflowSpecRef) {
      references.push({ kind: 'spec-workflow', location: workflowSpecRef, status: 'reference-only',
        source_refs: ['workflow'] });
    }
    for (const [index, location] of mirrorLocations.entries()) {
      let state: SourceFact['state'] = 'missing', digest: string | null = null,
        localObservedAt: string | null = root ? observedAt : null, sourceUpdatedAt: string | null = null;
      if (root) {
        const candidate = path.resolve(root, location), relation = path.relative(root, candidate);
        if (relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) state = 'unavailable';
        else if (existsSync(candidate)) {
          try {
            const file = lstatSync(candidate), real = realpathSync(candidate), canonicalRelation = path.relative(root, real);
            if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 64 * 1024
              || canonicalRelation === '..' || canonicalRelation.startsWith('..' + path.sep)) state = 'unavailable';
            else { digest = `sha256:${createHash('sha256').update(readFileSync(candidate)).digest('hex')}`;
              state = 'observed'; sourceUpdatedAt = file.mtime.toISOString(); }
          } catch { state = 'unavailable'; }
        }
      } else state = 'unavailable';
      const id = `spec-mirror-${index + 1}`;
      references.push({ kind: 'spec-mirror', location, status: state, source_refs: [id], observed_at: localObservedAt });
      specSources.push(source({ id, kind: 'spec', locator: location, revision: null, digest,
        observed_at: localObservedAt, source_updated_at: sourceUpdatedAt, state }));
    }
    if (canonicalSpec) {
      const local = specSources.find(value => value.id.startsWith('spec-mirror-') && value.locator === canonicalSpec);
      const canonical = specSources.find(value => value.id === 'spec-canonical');
      const canonicalReference = references.find(value => value.kind === 'spec' && value.canonical);
      if (local && canonical && canonicalReference) {
        canonical.state = local.state; canonical.digest = local.digest; canonical.observed_at = local.observed_at;
        canonical.source_updated_at = local.source_updated_at;
        canonicalReference.status = local.state; canonicalReference.observed_at = local.observed_at;
      }
    }
    let preflight: ContextFacts['preflight'] = { capabilities: null, dependencies: [], status: 'unavailable',
      target_packages: [], target_package_source: null, source_refs: ['host', 'implementation-authority'] };
    if (root) {
      try {
        const capabilities = inspectHostCapabilities(root);
        if (!this.authority) throw new Error('implementation authority unavailable');
        const snapshot = this.authority.snapshot(ticket.key, '');
        const packages = targetDependencyPackages(snapshot.policy);
        preflight = { capabilities, target_packages: packages, target_package_source: snapshot.source.reference,
          dependencies: packages.map(directory => inspectDependency(root, directory)),
          status: 'observed', source_refs: ['host', 'implementation-authority'] };
      }
      catch { /* Preserve an explicit unavailable fact. */ }
    }
    const hostRef = source({ id: 'host', kind: 'host', locator: root ?? 'unavailable', revision: null,
      digest: preflight.capabilities ? `sha256:${(preflight.capabilities as { path_digest: string }).path_digest}` : null,
      observed_at: preflight.capabilities ? (preflight.capabilities as { observed_at: string }).observed_at : null,
      source_updated_at: null, state: preflight.status });
    return {
      project: { id: project.id, key: project.key, name: project.name, source_refs: ['ticket'] },
      ticket: { id: ticket.id, key: ticket.key, title: ticket.title, reference: ticket.reference, source_refs: ['ticket'] },
      baseline: { fixed_point: ticket.comparison_baseline?.commit_oid ?? null, source_refs: ['ticket', 'git'] },
      identity, workflow, checkpoint, implementation_notes: notes, execution, preflight,
      recording: { state: recordingHealth.state, reason: recordingHealth.reason, source_refs: ['harness'] },
      references,
      sources: [ticketRef, gitRef, workflowRef, checkpointRef, notesRef, runtimeRef, harnessRef, hostRef, ...specSources],
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
    const operations = this.harness.executionOperations?.observations(ticketId) ?? [];
    const runIds = new Set(observed.filter(value => value.runtime_kind === 'codex-run').map(value => value.run_id));
    const usageByRun = new Map<string, { input_tokens: number; cached_input_tokens: number; output_tokens: number }>();
    for (const record of this.harness.journal?.records ?? []) {
      if (record.data.kind !== 'event' || record.data.event.kind !== 'codex'
        || !record.data.event.run_id || !runIds.has(record.data.event.run_id)) continue;
      const payload = record.data.event.payload as Record<string, unknown>;
      if (payload?.type !== 'turn.completed' || !payload.usage || typeof payload.usage !== 'object') continue;
      const raw = payload.usage as Record<string, unknown>;
      const token = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      const input = token(raw.input_tokens), cached = token(raw.cached_input_tokens), output = token(raw.output_tokens);
      if (input !== null && cached !== null && output !== null) usageByRun.set(record.data.event.run_id,
        { input_tokens: input, cached_input_tokens: cached, output_tokens: output });
    }
    const usage = usageByRun.size ? { state: 'observed' as const,
      value: [...usageByRun.values()].reduce<{ runs: number; input_tokens: number; cached_input_tokens: number;
        output_tokens: number }>((sum, value) => ({ runs: sum.runs + 1,
        input_tokens: sum.input_tokens + value.input_tokens,
        cached_input_tokens: sum.cached_input_tokens + value.cached_input_tokens,
        output_tokens: sum.output_tokens + value.output_tokens }),
      { runs: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }), source_refs: [sourceRef, 'harness'] }
      : { state: 'unavailable' as const, value: null, source_refs: [sourceRef, 'harness'] };
    return { observed, operations, coverage: { bindings: bindings.length, workflow_runtime_refs: runtimeRefs.length,
      global: false, complete }, usage, source_refs: [sourceRef, ...(workflow ? ['workflow'] : [])] };
  }
}
