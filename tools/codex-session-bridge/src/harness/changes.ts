import type { Binding, Source, Ticket } from './model.ts';
import { ChangesSource, ChangesSourceError } from './changes-source.ts';
import type { EvidenceGap } from './changes-source.ts';

const unavailableSources = (checkedAt: string) => ({
  git: { state: 'unavailable' as const, observed_at: checkedAt },
  filesystem: { state: 'unavailable' as const, observed_at: checkedAt },
  event_store: { state: 'observed' as const, observed_at: checkedAt },
});

export class Changes {
  source: Source;
  facts: ChangesSource;
  constructor(source: Source, facts = new ChangesSource()) { this.source = source; this.facts = facts; }

  view(ticket: Ticket, bindings: Iterable<Binding>, workflowFixedPoint: string | null = null) {
    const checkedAt = new Date().toISOString();
    if (!ticket.comparison_baseline) {
      const gap = ticket.comparison_baseline_gap ?? { code: 'BASELINE_NOT_RECORDED' as const,
        source: 'git/filesystem' as const, impact: 'legacy Ticket has no recorded comparison baseline' };
      return { state: 'unavailable' as const, baseline: null, current_head: null, files: [], commits: [], runs: [],
        freshness: 'unknown' as const, checked_at: checkedAt, sources: unavailableSources(checkedAt), evidence_gaps: [gap] };
    }
    let current;
    try { current = this.facts.inspect(ticket.comparison_baseline); }
    catch (error) {
      const code = error instanceof ChangesSourceError ? error.code : 'GIT_UNAVAILABLE';
      return { state: 'unavailable' as const, baseline: ticket.comparison_baseline, current_head: null,
        files: [], commits: [], runs: [], freshness: 'unknown' as const, checked_at: checkedAt,
        sources: unavailableSources(checkedAt), evidence_gaps: [{ code, source: 'git', impact: 'current Changes cannot be verified' }] };
    }
    const relevant = [...bindings].filter(binding => binding.ticket_id === ticket.id);
    const runs: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const gaps: EvidenceGap[] = [...current.gaps];
    for (const binding of relevant) {
      try {
        const candidates = this.source.runs(binding.session_id).filter(run => binding.scope === 'session' || run.id === binding.run_id);
        for (const run of candidates) {
          if (seen.has(run.id)) continue;
          seen.add(run.id);
          runs.push({ session_id: run.session_id, run_id: run.id, status: run.status, model: run.model, reasoning: run.reasoning,
            association: 'ticket-process', binding_id: binding.id, modification_ownership: 'not-proven', ownership_evidence: [] });
        }
      } catch { gaps.push({ code: 'OBSERVATION_GAP', source: 'event-store', impact: 'a bound run is not currently readable' }); }
    }
    const associations = runs.map(run => ({ session_id: run.session_id, run_id: run.run_id, association: 'ticket-process' }));
    const start = new Map<string, { sha256: string | null }>();
    for (const entry of ticket.comparison_baseline.start_observation.entries) start.set(entry.path, entry);
    const files = current.files.map(file => {
      const entry = start.get(file.path) ?? (file.old_path ? start.get(file.old_path) : undefined);
      const startRelation = !entry ? 'observed-after-start'
        : entry.sha256 !== null && entry.sha256 === file.content.sha256 ? 'pre-existing-at-start' : 'pre-existing-overlap';
      return { ...file, start_relation: startRelation, process_associations: associations,
        modification_ownership: 'not-proven', ownership_evidence: [] };
    });
    const commits = current.commits.map(commit => ({ ...commit, association: 'comparison-range',
      modification_ownership: 'not-proven', ownership_evidence: [] }));
    if (ticket.comparison_baseline.start_observation.integrity !== 'complete') gaps.push({ code: 'START_SNAPSHOT_INCOMPLETE',
      source: 'filesystem', impact: 'some start fingerprints were unavailable or truncated' });
    if (workflowFixedPoint && workflowFixedPoint !== ticket.comparison_baseline.commit_oid) gaps.push({ code: 'BASELINE_WORKFLOW_MISMATCH',
      source: 'workflow', impact: 'Workflow fixed point differs from the immutable Ticket comparison baseline' });
    gaps.push({ code: 'ATTRIBUTION_UNPROVEN', source: 'event-store',
      impact: 'run and commit associations do not prove modification ownership' });
    gaps.push({ code: 'OBSERVATION_GAP', source: 'event-store',
      impact: 'Changes are current net facts and do not reconstruct unobserved intermediate edits' });
    return { state: 'available' as const, baseline: ticket.comparison_baseline, current_head: current.current_head,
      files, commits, runs, freshness: 'current' as const, checked_at: current.checked_at,
      sources: { ...current.sources, event_store: { state: 'observed' as const, observed_at: checkedAt } }, evidence_gaps: gaps };
  }
}
