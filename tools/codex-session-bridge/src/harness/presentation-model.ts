// Shared wire contract. No provider payloads or server/runtime imports in the UI.
export interface Participant {
  id: string; role: 'owner' | 'coordinator' | 'engineer' | 'system'; label: string;
  provider?: string; model?: string;
}
export interface SourceRef { kind: 'record' | 'source' | 'session' | 'run' | 'thread' | 'binding'; id: string }
export interface ItemIntegrity { redacted: boolean; truncated: boolean | 'unknown'; incomplete: boolean | 'unknown' }
export interface ExecutionMetadata {
  category: 'command' | 'tool' | 'observation' | 'output';
  source: string; scope: string | null; operationId: string | null;
  observedAt: string; status: string; issues: string[];
}
interface ItemBase {
  id: string; participant: Participant; timestamp: string; cursor: number; sourceRefs: SourceRef[];
  integrity: ItemIntegrity; rawEvidence: unknown;
  execution?: ExecutionMetadata;
}
export type ConversationItem = ItemBase & (
  | { kind: 'message'; content: { text: string } }
  | { kind: 'tool'; content: { title: string; status: string; command: string | null; output: string | null } }
  | { kind: 'lifecycle' | 'workflow' | 'control' | 'task' | 'unknown'; content: { title: string; text: string; status: string | null } }
);
export interface PageInfo {
  first_cursor: number | null; last_cursor: number | null; high_water_cursor: number;
  has_older: boolean; has_newer: boolean;
}
export interface ConversationLink {
  id: string; label: string; kind: 'main' | 'review' | 'focused' | 'acceptance';
  isolation: string | null; original_review_id: string | null; finding_refs: string[];
  review_id: string | null; participant: string | null;
}
export interface ConversationPage {
  id: string; ticket_id: string; items: ConversationItem[]; page: PageInfo;
}
export interface ComposerCapability { mode: 'read-only'; reason: string }
export interface SessionDto { csrf: string; composer: ComposerCapability; services_url: string | null }
export interface TicketSummary {
  id: string; key: string; title: string; phase: string; accepted: boolean; findings: number;
  review_status: string; changes_state: string; file_count: number; attention: boolean;
}
export interface ProjectDto { id: string; key: string; name: string; tickets: TicketSummary[] }
export interface OverviewDto { projects: ProjectDto[]; recording: { state: string; reason: string | null; observed_at: string | null } }
export interface ChangeFileDto {
  file_id: string; revision: string; path: string; old_path: string | null; change_kind: string;
  content_state: string; content_type: string; start_relation: string;
}
export interface ChangesDto {
  state: string; baseline: string | null; current_head: string | null; checked_at: string;
  freshness: string; completeness: string; files: ChangeFileDto[];
  commits: Array<{ oid: string; subject: string }>; run_count: number;
  evidence_gaps: Array<{ code: string; impact: string }>;
}
export interface PatchDto {
  file_id: string; revision: string; baseline: string | null; current_head: string | null; checked_at: string; freshness: string;
  state: 'available' | 'binary' | 'deleted' | 'protected' | 'too-large' | 'truncated' | 'stale' | 'unavailable';
  patch: string | null; integrity: { redacted: boolean; complete: boolean; reason: string | null };
}
export interface ReviewDto {
  id: string; mode: string; status: string; applicability: string; standards: string; spec: string;
  original_review_id: string | null;
}
export interface WorkflowDto {
  phase: string; revision: number | null; assessment: string; acceptance: string; accepted: boolean;
  closeout: string; reviews: ReviewDto[]; findings: Array<{ id: string; origin_review_id: string; identity: string; status: string; title: string }>;
}
export interface ControlTarget { kind: 'run' | 'task'; id: string; status: string; observation: string; manageable: boolean }
export interface TicketDto {
  ticket: { id: string; key: string; title: string; reference: string; main_conversation_id: string };
  conversations: ConversationLink[]; conversation: ConversationPage; workflow: WorkflowDto;
  changes: ChangesDto; controls: ControlTarget[]; recording: OverviewDto['recording']; rawEvidence: unknown;
}
