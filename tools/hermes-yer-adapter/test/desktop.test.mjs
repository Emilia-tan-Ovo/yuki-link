import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../../codex-session-bridge/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const atom = value => ({ get: () => value });
const source = randomUUID(), ticket = randomUUID();
const fixture = {
  host: { state: { connectionId: atom('local'), profile: atom('main'), focusedSessionOwner: atom({ connectionId: 'local', profile: 'main' }),
    focusedStoredSessionId: atom('durable-chat') }, paneVisibility: () => atom(true) },
  useValue: value => value.get(), Button: 'button', Badge: 'span', LogView: 'pre',
  queryClient: { getQueryData: () => null, invalidateQueries() {}, removeQueries() {} },
  queries: [], snapshots: {
    connection: { source_id: source, connection_id: 'local', profile: 'main', csrf: 'fixture' },
    tickets: { tickets: [{ id: ticket, title: 'Fixture', key: 'TEST-1' }] },
    snapshot: { source_id: source, ticket: { project_id: 'project', key: 'TEST-1', title: 'Fixture', expected_worktree: 'fixture-worktree' },
      main_conversation: { conversation_id: 'main' }, child_conversations: [], work_items: [], plans: [], operations: [],
      runs: [{ backend_kind: 'codex', model: 'gpt-6-astra', reasoning: 'xhigh', service_tier: 'fast', status: 'running', run_id: 'run',
        source_ref: 'session:same/run:same', permissions: { sandbox_mode: 'danger-full-access', source: 'fixture-native' } }],
      changes: { current: { state: 'available', files: [{ file_id: 'file', revision: 'revision', path: 'changed.txt', layer: 'staged' }], evidence_gaps: [] },
        cumulative: { files: [], commits: [] } }, workflow: { current: { phase: 'review', reviews: [],
          findings: [{ finding_id: 'F-1', status: 'fixed-unverified', summary: 'Await verification' }],
          acceptance: { status: 'pending' } } }, capabilities: {}, gaps: [], high_water_cursor: 3 },
    events: { events: [{ event_id: 'event', observed_at: 'fixture-time', category: 'tool/command',
      payload: { command: 'fixture <script>alert(1)</script>' }, source_ref: 'journal:fixture:3' }] },
  },
};
fixture.useQuery = options => {
  fixture.queries.push(options);
  if (!options.enabled) return { data: undefined, refetch() {} };
  const kind = options.queryKey.findLast(value => Object.hasOwn(fixture.snapshots, value));
  return { data: fixture.snapshots[kind], isError: false, refetch() {} };
};
globalThis.__yerSdkFixture = fixture;
const sdk = 'data:text/javascript,' + encodeURIComponent("export const { host, useValue, useQuery, queryClient, Button, Badge, LogView } = globalThis.__yerSdkFixture;");
const code = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  .replace("from '@hermes/plugin-sdk'", 'from ' + JSON.stringify(sdk))
  .replace("from 'react'", 'from ' + JSON.stringify(pathToFileURL(require.resolve('react')).href));
const plugin = await import('data:text/javascript,' + encodeURIComponent(code + '\n//# sourceURL=yer-plugin-fixture.mjs'));

test('event cursors deduplicate, preserve filtering gaps and refuse cross-source cache mixing', () => {
  const event = { event_id: 'one', source_id: source, cursor: 3 };
  let cache = plugin.mergeEventPage(null, { source_id: source, events: [event], next_cursor: 7, high_water_cursor: 10, has_more: true });
  cache = plugin.mergeEventPage(cache, { source_id: source, events: [event, { ...event, event_id: 'two', cursor: 9 }],
    next_cursor: 10, high_water_cursor: 10, has_more: false });
  assert.deepEqual(cache.events.map(item => item.event_id), ['one', 'two']);
  assert.equal(cache.cursor, 10);
  assert.throws(() => plugin.mergeEventPage(cache, { source_id: randomUUID(), events: [], next_cursor: 11 }), /SOURCE_CHANGED/);
  assert.throws(() => plugin.mergeEventPage(cache, { source_id: source, events: [], next_cursor: 2 }), /INVALID_CURSOR/);
});

test('history first fixes high water, then resumes increments; cancellation discards the observation', async () => {
  const calls = [], ctx = { rest: async (route, options) => {
    calls.push({ route, options });
    return { source_id: source, events: [], next_cursor: calls.length === 1 ? 6 : 12, high_water_cursor: 12, has_more: calls.length === 1 };
  } };
  let cache = await plugin.readEventPage(ctx, ticket, source, null, 12, '', null);
  assert.match(calls[0].route, /after=0.*until=12/);
  assert.equal(cache.history_complete, false);
  cache = await plugin.readEventPage(ctx, ticket, source, cache, 20, '', null);
  assert.match(calls[1].route, /after=6.*until=12/);
  assert.equal(cache.history_complete, true);
  cache = await plugin.readEventPage(ctx, ticket, source, cache, 25, '', null);
  assert.match(calls[2].route, /after=12/); assert.doesNotMatch(calls[2].route, /until=/);
  assert.ok(calls.every(call => !call.options.method || call.options.method === 'GET'));
  const controller = new AbortController(); let resolve;
  const pending = plugin.rest({ rest: () => new Promise(done => { resolve = done; }) }, '/read', {}, controller.signal);
  controller.abort(); resolve({ source_id: source });
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(plugin.rest({ rest: async () => ({ error: { code: 'OUTCOME_UNKNOWN', reconciliation_required: true } }) }, '/read'),
    error => error.code === 'OUTCOME_UNKNOWN' && error.reconciliation_required);
});

test('SDK-only pane renders process, current files and pending evidence without interpreting payload as HTML', () => {
  let contribution;
  const ctx = { register: value => { contribution = value; }, storage: {
    get: key => key === JSON.stringify(['yer-engineering', 'local', 'main', 'durable-chat']) ? { source_id: source, ticket_id: ticket } : null,
    set() {} } };
  plugin.default.register(ctx);
  assert.equal(contribution.area, 'panes');
  const markup = renderToStaticMarkup(contribution.render());
  for (const value of ['gpt-6-astra', 'danger-full-access', 'fixture-native', 'changed.txt', 'fixed-unverified', 'Acceptance', 'pending', '工具 / 命令'])
    assert.ok(markup.includes(value), value);
  assert.ok(!markup.includes('<script>'));
  assert.ok(markup.includes('&lt;script&gt;'));
  assert.ok(!markup.includes('<details open'));
  assert.ok(fixture.queries.filter(query => query.enabled).every(query =>
    query.queryKey.includes('local') && query.queryKey.includes('main') && query.queryKey.includes('durable-chat')));
  fixture.host.state.connectionId = atom('other-host');
  const other = renderToStaticMarkup(contribution.render());
  assert.ok(!other.includes('changed.txt'));
});
