import { z } from 'zod';

const id = z.string().uuid();
const text = z.string().min(1).max(512);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const workItemReferenceSchema = z.object({ work_item_id: id, revision: z.number().int().positive() }).strict();
export const workItemScopeSchema = z.object({ scope_ref: text, parent_work_item_id: id, decision_ref: text }).strict();
export const workItemStateSchema = z.enum(['ready', 'active', 'awaiting_verification', 'completed', 'blocked', 'cancelled']);
export const workItemSchema = z.object({
  schema_version: z.literal(1), work_item_id: id, delivery_item_id: id,
  purpose: z.enum(['design', 'implementation', 'repair', 'primary-review', 'focused-review', 'acceptance']),
  subject_ref: text, scope_ref: text, scope_digest: digest, authority_digest: digest, cycle_id: text.nullable(),
  destination_digest: digest,
  parent_refs: z.array(id), issue_set: z.array(text), revision: z.number().int().positive(), state: workItemStateSchema,
  generation: z.number().int().nonnegative(),
  generations: z.array(z.object({ generation: z.number().int().positive(), session_id: id.nullable(),
    state: z.enum(['usable', 'suspended', 'retired']), permissions_digest: digest.nullable(),
    reason: text }).strict()),
  operation_id: id.nullable(), content_version: text.nullable(),
  review_content_version: text.nullable(),
  review_budget: z.number().int().nonnegative(), review_rounds: z.number().int().nonnegative(),
  review_history: z.array(z.object({ round: z.number().int().positive(), review_id: text,
    content_version: text, workflow_revision: z.number().int().positive(),
    conclusion: z.enum(['passed', 'findings', 'incomplete']).nullable(),
    conclusion_digest: digest.nullable() }).strict()).default([]),
  verification_issue_set: z.array(text).default([]),
  evidence_refs: z.array(text),
}).strict();
export const workItemExecutionSchema = z.object({ item: workItemSchema,
  mode: z.enum(['fresh', 'continue', 'replace']), session_id: id.nullable() }).strict();
export const workItemTransitionRecordSchema = z.object({ kind: z.literal('work_item_transitioned'),
  previous_revision: z.number().int().positive(), item: workItemSchema, decision_ref: text }).strict();
export const workItemDecisionSchema = z.object({ decision_ref: text, work_item_id: id,
  expected_revision: z.number().int().positive(), workflow_revision: z.number().int().positive(),
  subject_ref: text, content_version: text,
  action: z.enum(['await-verification', 'complete', 'reopen', 'retire-generation', 'cancel', 'review-budget']),
  evidence_refs: z.array(text).min(1).max(32), review_id: text.optional(),
  review_budget: z.number().int().positive().optional(),
  next_authority_digest: digest.optional(),
}).strict();
export type WorkItemDecision = z.infer<typeof workItemDecisionSchema>;
export const rawExecutionRecordSchema = z.object({ kind: z.literal('raw_execution'), request_id: text,
  payload_digest: digest, authority_digest: digest, authorization_ref: text,
  category: z.enum(['compatibility', 'diagnostic', 'admin']), action: z.enum(['start', 'send']),
  state: z.enum(['reserved', 'dispatching', 'failed']), reason: text }).strict();
export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkItemExecution = z.infer<typeof workItemExecutionSchema>;
