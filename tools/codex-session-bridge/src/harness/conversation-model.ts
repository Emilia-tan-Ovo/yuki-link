import { z } from 'zod';

const id = z.string().uuid();
const text = z.string().min(1).max(512);
const bindingSchema = z.object({
  id, ticket_id: id, conversation_id: id, source_id: id,
  session_id: id, scope: z.enum(['session', 'run']), run_id: id.nullable(), attached_at: text,
});
export const childRelationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('review'), review_id: text,
    participant: z.enum(['coordinator', 'standards', 'spec']) }).strict(),
  z.object({ kind: z.literal('acceptance'), acceptance_id: text }).strict(),
]);
export const childAssociationSchema = z.object({
  ticket_id: id, request_id: z.string().min(1).max(128), session_id: id, run_id: id,
  relation: childRelationSchema,
}).strict();
export const childConversationSchema = z.object({
  conversation_id: id, ticket_id: id, parent_conversation_id: id,
  relation: childRelationSchema, created_at: z.string().datetime(),
}).strict();
export const isolationAssessmentSchema = z.object({
  state: z.enum(['verified', 'unknown', 'mismatch']), assessed_at: z.string().datetime(),
  reasons: z.array(z.object({ code: text, source: text }).strict()).max(32),
}).strict();
export const childConversationAssociationRecordSchema = z.object({
  request_id: text, fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  conversation: childConversationSchema, binding: bindingSchema,
  previous_session_id: id.nullable(), isolation: isolationAssessmentSchema,
}).strict();

export type ChildAssociation = z.infer<typeof childAssociationSchema>;
export type ChildConversation = z.infer<typeof childConversationSchema>;
export type IsolationAssessment = z.infer<typeof isolationAssessmentSchema>;
export type ChildConversationAssociationRecord = z.infer<typeof childConversationAssociationRecordSchema>;
