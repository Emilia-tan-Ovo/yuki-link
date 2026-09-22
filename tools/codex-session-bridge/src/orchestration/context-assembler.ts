import { randomUUID } from 'node:crypto';
import { CONTEXT_POLICY_VERSION, CONTEXT_SCHEMA_VERSION, RESUME_POLICY_VERSION } from './context-contract.ts';
import type { ContextFacts, ContextFactsSource, ContextTrigger, EvidenceState, ReadinessState, RequestedAction } from './context-contract.ts';

const supportedActions = new Set(['discovery', 'spec', 'tickets', 'ticket-design', 'implementation', 'review', 'acceptance', 'closeout']);
const MAX_PACKET_BYTES = 24 * 1024;
const MAX_RETRIEVAL = 32;
const MAX_FINDINGS = 64;
const MAX_IDENTITY_LAYER = 128;
const MAX_EXECUTIONS = 128;
const MAX_UNKNOWN_SIDE_EFFECTS = 24;

interface Issue { code: string; detail: string; source_refs: string[] }

const unique = <T>(values: T[], key: (value: T) => string) => {
  const seen = new Set<string>(); return values.filter(value => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; });
};
const issue = (code: string, detail: string, source_refs: string[]): Issue => ({ code, detail, source_refs });
const stateFor = (conflicts: Issue[], stale: Issue[], unknowns: Issue[]): EvidenceState => conflicts.length ? 'conflicted'
  : stale.length ? 'stale' : unknowns.length ? 'partial' : 'complete';

export class ContextAssembler {
  facts: ContextFactsSource;
  constructor(facts: ContextFactsSource) { this.facts = facts; }

  assemble(input: { ticket_id: string; requested_action: RequestedAction; trigger: ContextTrigger }) {
    const facts = this.facts.collect(input.ticket_id);
    const conflicts: Issue[] = [], staleSources: Issue[] = [], unknowns: Issue[] = [], omissions: Array<Record<string, unknown>> = [];
    const checkpoint = facts.checkpoint, checkpointFields = checkpoint.fields as Record<string, string | null>;
    const currentHead = (facts.identity.payload as { head?: string | null } | undefined)?.head ?? null;
    if (checkpoint.status !== 'observed') unknowns.push(issue('CHECKPOINT_' + checkpoint.status.toUpperCase().replaceAll('-', '_'),
      `checkpoint is ${checkpoint.status}`, ['checkpoint']));
    if (facts.implementation_notes.status !== 'observed') unknowns.push(issue('IMPLEMENTATION_NOTES_' + facts.implementation_notes.status.toUpperCase().replaceAll('-', '_'),
      `Implementation Notes are ${facts.implementation_notes.status}`, ['implementation-notes']));
    if (facts.identity.completeness !== 'complete') unknowns.push(issue('SUBJECT_IDENTITY_INCOMPLETE',
      'current subject identity cannot prove equality', facts.identity.source_refs));
    if (checkpoint.status === 'observed' && checkpointFields.head && currentHead && checkpointFields.head !== currentHead) {
      staleSources.push(issue('CHECKPOINT_HEAD_STALE', 'checkpoint HEAD differs from current Git HEAD', ['checkpoint', 'git']));
    }
    if (checkpoint.status === 'observed' && checkpointFields.fixed_point && facts.baseline.fixed_point
      && checkpointFields.fixed_point !== facts.baseline.fixed_point) {
      conflicts.push(issue('FIXED_POINT_CONFLICT', 'checkpoint fixed point differs from registered comparison baseline', ['checkpoint', 'ticket', 'git']));
    }
    if (facts.workflow && checkpoint.status === 'observed' && checkpointFields.phase && checkpointFields.phase !== facts.workflow.phase) {
      conflicts.push(issue('PHASE_CONFLICT', 'checkpoint recovery phase differs from recorded Workflow phase', ['checkpoint', 'workflow']));
    }
    if (facts.workflow?.assessment === 'stale') staleSources.push(issue('WORKFLOW_STALE', 'Workflow evidence assessment is stale', ['workflow']));
    if (facts.workflow?.assessment === 'mismatch') conflicts.push(issue('WORKFLOW_MISMATCH', 'Workflow evidence assessment reports a mismatch', ['workflow']));
    if (facts.workflow && ['unknown', 'not-applicable'].includes(facts.workflow.assessment)) {
      unknowns.push(issue('WORKFLOW_UNVERIFIED', `Workflow assessment is ${facts.workflow.assessment}`, ['workflow']));
    }
    if (!facts.workflow) unknowns.push(issue('WORKFLOW_NOT_OBSERVED', 'no structured Workflow snapshot is recorded', ['workflow']));
    if (!facts.execution.coverage.complete) unknowns.push(issue('EXECUTION_COVERAGE_INCOMPLETE',
      'one or more referenced executions could not be observed', facts.execution.source_refs));
    const uncertainOperations = facts.execution.operations.filter(value => value.state === 'dispatching'
      || value.state === 'reconciliation-required' || value.effective_state === 'reconciliation-required');
    if (uncertainOperations.length) unknowns.push(issue('EXECUTION_OPERATION_RECONCILIATION_REQUIRED',
      'one or more durable execution operations require read-only reconciliation', facts.execution.source_refs));
    if (facts.recording.state !== 'recording') unknowns.push(issue('HARNESS_EVIDENCE_GAP',
      `Harness recording state is ${facts.recording.state}`, facts.recording.source_refs));
    const sideEffectDeclarations = checkpoint.declarations.unknown_side_effects;
    if (sideEffectDeclarations.length > MAX_UNKNOWN_SIDE_EFFECTS) omissions.push({ category: 'unknown-side-effects',
      reason: 'item-limit', count: sideEffectDeclarations.length - MAX_UNKNOWN_SIDE_EFFECTS, retrieval_ref: checkpoint.location });
    const checkpointSideEffects = sideEffectDeclarations.slice(0, MAX_UNKNOWN_SIDE_EFFECTS).map((summary, index) => ({
      id: `checkpoint-side-effect-${index + 1}`, state: 'unknown', summary: summary.slice(0, 256), declaration_only: true, source_refs: ['checkpoint'],
    }));
    const operationSideEffects = uncertainOperations.map(value => ({ id: `execution-operation-${String(value.operation_id)}`,
      state: 'unknown', summary: `durable execution operation ${String(value.operation_id)} requires reconciliation`,
      declaration_only: false, operation_id: value.operation_id, source_refs: value.source_refs }));
    const unknownSideEffects = [...operationSideEffects, ...checkpointSideEffects].slice(0, MAX_UNKNOWN_SIDE_EFFECTS);
    if (operationSideEffects.length + checkpointSideEffects.length > MAX_UNKNOWN_SIDE_EFFECTS) omissions.push({
      category: 'unknown-side-effects', reason: 'item-limit',
      count: operationSideEffects.length + checkpointSideEffects.length - MAX_UNKNOWN_SIDE_EFFECTS,
      retrieval_ref: 'durable execution operations / checkpoint',
    });
    const truncatedSideEffects = sideEffectDeclarations.filter(summary => summary.length > 256).length;
    if (truncatedSideEffects) omissions.push({ category: 'unknown-side-effect-text', reason: 'text-limit',
      count: truncatedSideEffects, retrieval_ref: checkpoint.location });
    if (unknownSideEffects.length) unknowns.push(issue('UNKNOWN_SIDE_EFFECT',
      'one or more side effects are not externally verified', unique(unknownSideEffects.flatMap(value => value.source_refs), value => value)));
    const integrity = { state: stateFor(conflicts, staleSources, unknowns), conflicts, stale_sources: staleSources, unknowns, omissions };
    const readiness = this.readiness(input.requested_action, facts, integrity.state, unknownSideEffects);
    const recommendation = this.recommend(input.requested_action, facts, integrity.state, readiness, unknownSideEffects);
    const plan = facts.implementation_notes.context_plan;
    const bounded = (values: string[] | undefined, category: string) => {
      const original = unique(values ?? [], value => value);
      if (original.length > MAX_RETRIEVAL) omissions.push({ category, reason: 'item-limit', count: original.length - MAX_RETRIEVAL,
        retrieval_ref: facts.implementation_notes.location });
      return original.slice(0, MAX_RETRIEVAL);
    };
    const findings = facts.workflow?.findings ?? [];
    if (findings.length > MAX_FINDINGS) omissions.push({ category: 'open-findings', reason: 'item-limit', count: findings.length - MAX_FINDINGS,
      retrieval_ref: 'workflow' });
    const identityPayload = facts.identity.payload as Record<string, any>;
    const identityGaps = Array.isArray(facts.identity.gaps) ? facts.identity.gaps as Array<Record<string, unknown>> : [];
    if (identityGaps.length > 16) omissions.push({ category: 'subject-identity-gaps', reason: 'item-limit',
      count: identityGaps.length - 16, retrieval_ref: 'git' });
    const projectedIdentity = { ...facts.identity, gaps: identityGaps.slice(0, 16).map(value => ({ ...value,
      impact: typeof value.impact === 'string' ? value.impact.slice(0, 256) : value.impact,
      path: typeof value.path === 'string' ? value.path.slice(0, 260) : value.path })),
      payload: { ...identityPayload } };
    for (const layer of ['index', 'worktree', 'untracked']) {
      const entries = Array.isArray(identityPayload[layer]) ? identityPayload[layer] as unknown[] : [];
      if (entries.length > MAX_IDENTITY_LAYER) omissions.push({ category: `subject-identity-${layer}`, reason: 'item-limit',
        count: entries.length - MAX_IDENTITY_LAYER, retrieval_ref: 'git' });
      projectedIdentity.payload[layer] = entries.slice(0, MAX_IDENTITY_LAYER);
      projectedIdentity.payload[`${layer}_count`] = entries.length;
    }
    const activeExecutions = facts.execution.observed.filter(value => value.classification === 'active');
    const terminalExecutions = facts.execution.observed.filter(value => value.classification === 'terminal');
    const unknownExecutions = facts.execution.observed.filter(value => value.classification === 'unknown');
    for (const [category, values] of [['active', activeExecutions], ['terminal', terminalExecutions], ['unknown', unknownExecutions]] as const) {
      if (values.length > MAX_EXECUTIONS) omissions.push({ category: `execution-${category}`, reason: 'item-limit',
        count: values.length - MAX_EXECUTIONS, retrieval_ref: 'runtime bindings / Workflow runtime refs' });
    }
    const packet: Record<string, any> = {
      schema_version: CONTEXT_SCHEMA_VERSION,
      packet_id: randomUUID(),
      assembled_at: new Date().toISOString(),
      trigger: { kind: input.trigger, requested_action: input.requested_action, authorizes_execution: false },
      subject: {
        project: facts.project, ticket: facts.ticket,
        phase: { workflow: facts.workflow?.phase ?? null, checkpoint: checkpointFields.phase ?? null,
          source_refs: [...(facts.workflow?.source_refs ?? []), 'checkpoint'] },
        workflow_revision: facts.workflow ? { value: facts.workflow.revision, source_refs: facts.workflow.source_refs } : null,
        fixed_point: { value: facts.baseline.fixed_point, source_refs: facts.baseline.source_refs },
        identity: projectedIdentity,
        legacy_workflow_subject: facts.workflow?.legacy_subject ?? null,
      },
      attention: {
        objective: { value: facts.ticket.title, source_refs: facts.ticket.source_refs },
        authorization_boundary: { value: 'preparation-only; no execution or Workflow transition is authorized', source_refs: ['ticket'] },
        next_action: recommendation,
        open_findings: findings.slice(0, MAX_FINDINGS),
        blockers: readiness.reasons,
        unknown_side_effects: unknownSideEffects,
        advisory_guardrails: [{ summary: 'Apply current repository and workflow instructions before execution',
          retrieval_ref: 'AGENTS.md', source_refs: ['ticket'] }],
      },
      execution: {
        review_policy: { value: facts.workflow?.review_policy ?? null, source_refs: facts.workflow?.source_refs ?? ['workflow'] },
        active: activeExecutions.slice(0, MAX_EXECUTIONS),
        terminal: terminalExecutions.slice(0, MAX_EXECUTIONS),
        unknown: unknownExecutions.slice(0, MAX_EXECUTIONS),
        operations: facts.execution.operations.slice(0, MAX_EXECUTIONS),
        coverage: { ...facts.execution.coverage, source_refs: facts.execution.source_refs },
        model_policy: { value: 'project-policy', retrieval_ref: 'AGENTS.md' },
        model_usage: { state: 'not-materialized', value: null, source_refs: facts.execution.source_refs },
        environment: { worktree: facts.identity.scope ?? null, recording: facts.recording },
      },
      retrieval: {
        context_plan: { status: facts.implementation_notes.status, adapter: facts.implementation_notes.adapter,
          location: facts.implementation_notes.location, digest: facts.implementation_notes.digest,
          core: bounded(plan?.core, 'context-plan-core'), related: bounded(plan?.related, 'context-plan-related'),
          retrieval: bounded(plan?.retrieval, 'context-plan-retrieval'), expansion_triggers: bounded(plan?.expansion_triggers, 'context-plan-expansion'),
          source_refs: ['implementation-notes'] },
        references: facts.references,
      },
      sources: facts.sources,
      integrity,
      action_readiness: readiness,
      recommendation,
      budget: { policy_version: CONTEXT_POLICY_VERSION, max_bytes: MAX_PACKET_BYTES, actual_bytes: 0 },
    };
    this.applyBudget(packet, omissions);
    packet.budget.actual_bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
    packet.budget.actual_bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
    return packet;
  }

  prepare(input: { ticket_id: string; requested_action: RequestedAction; trigger: ContextTrigger }) {
    const packet = this.assemble(input);
    return { schema_version: CONTEXT_SCHEMA_VERSION, kind: 'ticket-resume', prepared_at: packet.assembled_at,
      ticket_id: input.ticket_id, verified_facts: { subject: packet.subject, execution: packet.execution },
      risks: { integrity: packet.integrity, blockers: packet.attention.blockers,
        unknown_side_effects: packet.attention.unknown_side_effects },
      recommendation: packet.recommendation, packet };
  }

  private readiness(action: string, facts: ContextFacts, integrity: EvidenceState, sideEffects: unknown[]) {
    const reasons: Issue[] = []; let state: ReadinessState = 'ready';
    if (!supportedActions.has(action)) return { state: 'unsupported' as const,
      reasons: [issue('UNSUPPORTED_ACTION', `requested action ${action} is not supported by contract v1`, ['ticket'])] };
    const active = facts.execution.observed.filter(value => value.classification === 'active');
    if (active.length) reasons.push(issue('ACTIVE_EXECUTION', 'an active execution exists in observed coverage', facts.execution.source_refs));
    const operations = facts.execution.operations.filter(value => !['failed', 'bound'].includes(String(value.state)));
    if (operations.length) reasons.push(issue('ACTIVE_EXECUTION_OPERATION',
      'a durable execution operation still owns an execution claim', facts.execution.source_refs));
    if (sideEffects.length) reasons.push(issue('UNKNOWN_SIDE_EFFECT', 'unknown side effects require reconciliation', ['checkpoint']));
    if (integrity === 'conflicted') reasons.push(issue('EVIDENCE_CONFLICT', 'conflicting evidence must be resolved', ['workflow', 'checkpoint', 'git']));
    if (integrity === 'stale') reasons.push(issue('STALE_EVIDENCE', 'stale recovery evidence must be reconciled', ['checkpoint', 'workflow', 'git']));
    const openFindings = facts.workflow?.findings.filter(value => ['open', 'fixed', 'fixed-unverified'].includes(String(value.status))) ?? [];
    if (openFindings.length && action !== 'review') reasons.push(issue('OPEN_FINDING',
      'an unresolved finding blocks the requested action', ['workflow']));
    if (reasons.length) state = 'blocked';
    else if (facts.identity.completeness !== 'complete' || !facts.execution.coverage.complete) {
      state = 'unknown'; reasons.push(issue('INSUFFICIENT_EVIDENCE', 'current evidence cannot establish preparation readiness',
        [...facts.identity.source_refs, ...facts.execution.source_refs]));
    } else if (integrity === 'partial') { state = 'unknown'; reasons.push(issue('PARTIAL_EVIDENCE',
      'one or more durable evidence sources are missing or unknown', ['workflow', 'checkpoint', 'implementation-notes'])); }
    return { state, reasons };
  }

  private recommend(action: string, facts: ContextFacts, integrity: EvidenceState,
    readiness: { state: ReadinessState; reasons: Issue[] }, sideEffects: unknown[]) {
    let kind = 'continue-requested-action', reason_code = 'EVIDENCE_READY';
    if (readiness.state === 'unsupported') { kind = 'unsupported-action'; reason_code = 'UNSUPPORTED_ACTION'; }
    else if (facts.execution.operations.some(value => value.state === 'dispatching'
      || value.state === 'started' || value.state === 'reconciliation-required'
      || value.effective_state === 'reconciliation-required')) {
      kind = 'reconcile-durable-operation'; reason_code = 'EXECUTION_OPERATION_RECONCILIATION_REQUIRED';
    } else if (facts.execution.operations.some(value => value.state === 'reserved')) {
      kind = 'inspect-reserved-operation'; reason_code = 'EXECUTION_OPERATION_RESERVED';
    }
    else if (facts.execution.observed.some(value => value.classification === 'active')) {
      kind = 'inspect-active-execution'; reason_code = 'ACTIVE_EXECUTION';
    } else if (sideEffects.length) { kind = 'reconcile-unknown-side-effect'; reason_code = 'UNKNOWN_SIDE_EFFECT'; }
    else if (integrity === 'conflicted') { kind = 'resolve-evidence-conflict'; reason_code = 'EVIDENCE_CONFLICT'; }
    else if (integrity === 'stale') { kind = 'reconcile-stale-evidence'; reason_code = 'STALE_EVIDENCE'; }
    else if (readiness.state === 'unknown') { kind = 'gather-missing-evidence'; reason_code = 'INSUFFICIENT_EVIDENCE'; }
    else if (facts.workflow?.findings.some(value => ['open', 'fixed', 'fixed-unverified'].includes(String(value.status)))) {
      kind = 'address-open-finding'; reason_code = 'OPEN_FINDING';
    }
    return { policy_version: RESUME_POLICY_VERSION, kind, reason_code, requested_action: action,
      recommended_transition: readiness.state === 'ready' ? action : null, executes: false,
      blockers: readiness.reasons, source_refs: unique(readiness.reasons.flatMap(value => value.source_refs), value => value) };
  }

  private applyBudget(packet: Record<string, any>, omissions: Array<Record<string, unknown>>) {
    const target = MAX_PACKET_BYTES - 256;
    const bytes = () => Buffer.byteLength(JSON.stringify(packet), 'utf8');
    const trim = (array: unknown[], category: string, retrievalRef: string) => {
      if (!array.length || bytes() <= target) return;
      const count = array.length;
      while (array.length && bytes() > target) array.pop();
      if (count !== array.length) omissions.push({ category, reason: 'total-byte-budget', count: count - array.length,
        retrieval_ref: retrievalRef });
    };
    trim(packet.retrieval.context_plan.related, 'context-plan-related', packet.retrieval.context_plan.location);
    trim(packet.retrieval.context_plan.retrieval, 'context-plan-retrieval', packet.retrieval.context_plan.location);
    trim(packet.retrieval.context_plan.core, 'context-plan-core', packet.retrieval.context_plan.location);
    trim(packet.subject.identity.payload.untracked, 'subject-identity-untracked', 'git');
    trim(packet.subject.identity.payload.worktree, 'subject-identity-worktree', 'git');
    trim(packet.subject.identity.payload.index, 'subject-identity-index', 'git');
    trim(packet.attention.open_findings, 'open-findings', 'workflow');
    trim(packet.execution.terminal, 'execution-terminal', 'runtime bindings / Workflow runtime refs');
    trim(packet.execution.unknown, 'execution-unknown', 'runtime bindings / Workflow runtime refs');
    trim(packet.execution.active, 'execution-active', 'runtime bindings / Workflow runtime refs');
    trim(packet.execution.operations, 'execution-operations', 'Harness execution operation journal');
    if (bytes() > MAX_PACKET_BYTES) omissions.push({ category: 'safety-core', reason: 'budget-exceeded-safety-fields-retained',
      count: 0, retrieval_ref: 'packet.integrity and packet.attention' });
  }
}
