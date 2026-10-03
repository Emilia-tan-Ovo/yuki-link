import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createMcpServer } from '../mcp.js';
import { createHttpServer } from '../http.js';
import { publicError } from '../errors.js';
import { HarnessError } from '../harness/model.ts';
import { engineeringPlanSchema, adapterScopeSchema } from './authority.js';

const ticket = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const workItem = z.object({ work_item_id: z.string().uuid(), revision: z.number().int().positive() }).strict();
const scope = adapterScopeSchema;
const patchQuery = z.object({ ticket_id: ticket, file_id: hash, revision: hash,
  mode: z.enum(['current', 'cumulative']).default('cumulative') }).strict();
const eventsQuery = z.object({ ticket_id: ticket, source_id: ticket, after: z.number().int().nonnegative().default(0),
  until: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).default(100),
  conversation_id: ticket.optional() }).strict();
const stopQuery = z.object({ ticket_id: ticket, work_item: workItem, session_id: ticket, run_id: ticket }).strict();
const errorResult = error => {
  const e = error instanceof HarnessError ? { code: error.code, message: error.message, details: error.details }
    : error instanceof z.ZodError ? { code: 'INVALID_REQUEST', message: 'Request schema mismatch' } : publicError(error);
  return { error: { ...e, retryable: /UNAVAILABLE|BUSY/.test(e.code),
    reconciliation_required: /RECONCIL|UNKNOWN/.test(e.code) } };
};
const body = async request => {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HarnessError('JSON_REQUIRED');
  const chunks = []; let count = 0;
  for await (const chunk of request) {
    count += chunk.length;
    if (count > 1024 * 1024) throw new HarnessError('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HarnessError('INVALID_JSON'); }
};
const sameToken = (actual, expected) => {
  if (!expected || typeof actual !== 'string') return false;
  const left = Buffer.from(actual), right = Buffer.from('Bearer ' + expected);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function stopEngineeringRun(manager, raw) {
  const input = stopQuery.parse(raw), item = manager.harness.executionOperations.workItems.get(input.work_item.work_item_id);
  if (item.delivery_item_id !== input.ticket_id || item.revision !== input.work_item.revision ||
      !item.generations.some(generation => generation.session_id === input.session_id))
    throw new HarnessError('WORK_ITEM_REVISION_CONFLICT');
  const binding = [...manager.harness.bindings.values()].find(value => value.ticket_id === input.ticket_id && value.session_id === input.session_id
    && (value.scope === 'session' || value.run_id === input.run_id));
  if (!binding) throw new HarnessError('RUN_NOT_FOUND');
  return manager.harness.controls.stopRun(input.ticket_id, input.run_id, binding.id);
}
export function createEngineeringMcpServer(manager) {
  const server = createMcpServer(manager, null, { engineeringOnly: true });
  const register = (name, description, schema, action, readOnly = true) => server.registerTool(name,
    { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, idempotentHint: true,
      destructiveHint: false, openWorldHint: !readOnly } }, async input => {
      try {
        const result = await action(input);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = errorResult(error);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  register('get_engineering_snapshot', 'Ticket-bound durable engineering snapshot; reading never starts a run.',
    z.object({ ticket_id: ticket }).strict(), input => manager.engineeringProjection.snapshot(input.ticket_id));
  register('get_engineering_events', 'Read bounded journal events using source identity and cursor, not run output cursor.',
    eventsQuery, ({ ticket_id, ...query }) => manager.engineeringProjection.events(ticket_id, query));
  register('get_engineering_patch', 'Read current or cumulative patch for an observed file/revision; never accepts cwd or Git refs.',
    patchQuery, ({ ticket_id, ...query }) => manager.engineeringProjection.patch(ticket_id, query));
  register('get_engineering_operation', 'Recover the original request receipt; unknown work is never relaunched.',
    z.object({ ticket_id: ticket, request_id: z.string().min(1).max(128) }).strict(),
    input => manager.engineering.operation(input.ticket_id, input.request_id) ?? { state: 'not-found', ...input });
  register('propose_engineering_action', 'Record a proposed managed workflow or verification plan for user preview. This grants no authority and starts nothing.',
    engineeringPlanSchema, input => manager.engineering.propose(input), false);
  register('stop_engineering_run', 'Request stop of an exact work item/session/run binding; observe until terminal.',
    stopQuery, input => stopEngineeringRun(manager, input), false);
  return server;
}
export function createEngineeringHttpServer(manager, { adapterToken = null, observation = {} } = {}) {
  const projection = manager.engineeringProjection, authority = manager.engineering;
  return createHttpServer(manager, null, observation, {
    identity: () => projection.identity(), mcpFactory: () => createEngineeringMcpServer(manager),
    handle: async (request, response) => {
      const send = (status, value) => response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(value));
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (request.method === 'GET' && url.pathname === '/engineering/identity') return send(200, projection.identity());
        if (request.headers['x-yer-source-id'] !== projection.identity().source_id) throw new HarnessError('SOURCE_CHANGED');
        if (request.method === 'GET' && url.pathname === '/engineering/tickets')
          return send(200, { ...projection.identity(), tickets: [...manager.harness.tickets.values()] });
        const route = /^\/engineering\/tickets\/([^/]+)(?:\/(events|patch|operations|preview|confirm|actions))?$/.exec(url.pathname);
        if (!route) return send(404, { error: { code: 'NOT_FOUND' } });
        const ticketId = ticket.parse(route[1]); authority.ticket(ticketId);
        const query = Object.fromEntries(url.searchParams);
        if (request.method === 'GET') {
          if (!route[2]) return send(200, projection.snapshot(ticketId));
          if (route[2] === 'events') {
            for (const key of ['after', 'until', 'limit']) if (key in query) query[key] = Number(query[key]);
            return send(200, projection.events(ticketId, eventsQuery.parse({ ...query, ticket_id: ticketId })));
          }
          if (route[2] === 'patch') return send(200, projection.patch(ticketId, patchQuery.parse({ ...query, ticket_id: ticketId })));
          if (route[2] === 'operations') {
            const parsed = z.object({ request_id: z.string().min(1).max(128) }).strict().parse(query);
            return send(200, { schema_version: 1, source_id: projection.identity().source_id, ticket_id: ticketId,
              receipt: authority.operation(ticketId, parsed.request_id) ?? { state: 'not-found' } });
          }
        }
        if (request.method !== 'POST') return send(405, { error: { code: 'METHOD_NOT_ALLOWED' } });
        // The dedicated adapter channel is absent from the model tool catalogue.
        if (!sameToken(request.headers.authorization, adapterToken)) return send(403, { error: { code: 'ADAPTER_NOT_AUTHENTICATED' } });
        const input = await body(request);
        if (route[2] === 'preview') {
          const parsed = z.object({ plan_id: ticket, scope }).strict().parse(input);
          if (!authority.records('engineering_plan').some(plan => plan.plan_id === parsed.plan_id && plan.ticket_id === ticketId))
            throw new HarnessError('ENGINEERING_PLAN_NOT_FOUND');
          return send(200, await authority.preview(parsed));
        }
        if (route[2] === 'confirm') {
          const parsed = z.object({ preview_id: ticket, payload_digest: hash, scope }).strict().parse(input);
          if (authority.getPreview(parsed.preview_id).ticket_id !== ticketId) throw new HarnessError('ENGINEERING_PREVIEW_NOT_FOUND');
          return send(200, { schema_version: 1, source_id: projection.identity().source_id, ticket_id: ticketId,
            receipt: await authority.confirm(parsed) });
        }
        if (route[2] === 'actions') {
          const action = z.discriminatedUnion('action', [
            z.object({ action: z.literal('start'), input: engineeringPlanSchema.options[0].shape.input }).strict(),
            z.object({ action: z.literal('stop'), input: stopQuery }).strict(),
            z.object({ action: z.literal('stop-task'), task_id: z.string().min(1).max(80) }).strict(),
            z.object({ action: z.literal('reconcile'), work_item: workItem }).strict(),
            z.object({ action: z.literal('transition'), work_item: workItem, decision_ref: z.string().min(1).max(512) }).strict(),
          ]).parse(input);
          let receipt;
          if (action.action === 'start' || action.action === 'stop') {
            if (action.input.ticket_id !== ticketId) throw new HarnessError('TICKET_SCOPE_CONFLICT');
            receipt = action.action === 'start' ? await authority.start(action.input) : stopEngineeringRun(manager, action.input);
          } else if (action.action === 'stop-task') receipt = manager.harness.stopTask(ticketId, action.task_id);
          else {
            const operations = manager.harness.executionOperations, item = operations.workItems.get(action.work_item.work_item_id);
            if (item.delivery_item_id !== ticketId || item.revision !== action.work_item.revision) throw new HarnessError('WORK_ITEM_REVISION_CONFLICT');
            if (action.action === 'reconcile') receipt = operations.reconcileWorkItem(action.work_item);
            else {
              if (!manager.executionAuthority) throw new HarnessError('WORK_ITEM_TRANSITION_NOT_AUTHORIZED');
              const decision = manager.executionAuthority.decision(action.decision_ref, authority.ticket(ticketId).expected_worktree);
              if (decision.work_item_id !== item.work_item_id || decision.expected_revision !== item.revision) throw new HarnessError('WORK_ITEM_REVISION_CONFLICT');
              receipt = operations.transitionWorkItem(decision);
            }
          }
          return send(200, { schema_version: 1, source_id: projection.identity().source_id, ticket_id: ticketId, receipt });
        }
        return send(404, { error: { code: 'NOT_FOUND' } });
      } catch (error) {
        const result = errorResult(error);
        send(/CONFLICT|STALE|EXPIRED|SOURCE_CHANGED|INVALID_CURSOR/.test(result.error.code) ? 409
          : /NOT_FOUND/.test(result.error.code) ? 404 : /INVALID|JSON_REQUIRED|TOO_LARGE/.test(result.error.code) ? 400 : 503, result);
      }
    },
  });
}
