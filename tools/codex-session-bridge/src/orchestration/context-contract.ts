export const CONTEXT_SCHEMA_VERSION = 1 as const;
export const CONTEXT_POLICY_VERSION = 'context-budget-v1' as const;
export const RESUME_POLICY_VERSION = 'resume-advisor-v1' as const;

export type RequestedAction = string;
export type ContextTrigger = 'manual' | 'handoff' | 'interruption' | 'service-restart';
export type EvidenceState = 'complete' | 'partial' | 'stale' | 'conflicted';
export type ReadinessState = 'ready' | 'blocked' | 'unknown' | 'unsupported';

export interface SourceFact {
  id: string;
  kind: 'ticket' | 'git' | 'workflow' | 'checkpoint' | 'implementation-notes' | 'runtime' | 'harness';
  locator: string;
  revision: string | number | null;
  digest: string | null;
  observed_at: string | null;
  source_updated_at: string | null;
  state: 'observed' | 'missing' | 'malformed' | 'unsupported-version' | 'reference-only' | 'unavailable';
}

export interface DocumentFact {
  status: 'observed' | 'missing' | 'malformed' | 'unsupported-version' | 'reference-only';
  adapter: 'markdown-context-v0';
  location: string;
  digest: string | null;
  observed_at: string | null;
  source_updated_at: string | null;
  fields: Record<string, unknown>;
  context_plan: { core: string[]; related: string[]; retrieval: string[]; expansion_triggers: string[] } | null;
  declarations: { unknown_side_effects: string[]; next_action: string[] };
}

export interface ContextFacts {
  project: { id: string; key: string; name: string; source_refs: string[] };
  ticket: { id: string; key: string; title: string; reference: string; source_refs: string[] };
  baseline: { fixed_point: string | null; source_refs: string[] };
  identity: Record<string, unknown> & { completeness: 'complete' | 'incomplete'; digest: string | null; source_refs: string[] };
  workflow: null | { revision: number; phase: string; assessment: string; legacy_subject: Record<string, unknown>;
    findings: Array<Record<string, unknown>>; review_policy: string | null; source_refs: string[] };
  checkpoint: DocumentFact;
  implementation_notes: DocumentFact;
  execution: { observed: Array<Record<string, unknown> & { source_refs: string[] }>;
    coverage: { bindings: number; workflow_runtime_refs: number; global: false; complete: boolean }; source_refs: string[] };
  recording: { state: string; reason: string | null; source_refs: string[] };
  references: Array<{ kind: string; location: string; status: 'reference-only'; source_refs: string[] }>;
  sources: SourceFact[];
}

export interface ContextFactsSource {
  collect(ticketId: string): ContextFacts;
}
