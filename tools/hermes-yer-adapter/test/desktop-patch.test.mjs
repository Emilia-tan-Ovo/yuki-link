import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run the production pane with deterministic hooks and a query-keyed cache.
// This verifies selection/cache transitions, not real Hermes UI acceptance.
test('SP-3: snapshot changes retire the selected patch before refresh and after removal', async () => {
  let cursor = 0, refCursor = 0, queries = [], effects = [];
  const states = [], refs = [], deps = [], cache = new Map();
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: initial => {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect: (fn, next) => {
      const i = cursor++;
      if (!deps[i] || next.some((value, k) => !Object.is(value, deps[i][k]))) effects.push(fn);
      deps[i] = next;
    },
    useRef: initial => refs[refCursor++] ??= { current: initial },
  };
  const atom = value => ({ get: () => value });
  let snapshot = { ticket: { project_id: 'project', key: 'T', title: 'fixture', expected_worktree: 'fixture' },
    main_conversation: { conversation_id: 'main' }, child_conversations: [], work_items: [], runs: [], plans: [],
    workflow: { current: null }, high_water_cursor: 0, capabilities: {}, gaps: [],
    changes: { current: { state: 'available', files: [
      { path: 'changed.txt', file_id: 'file', revision: 'before-edit', layer: 'unstaged' },
    ], evidence_gaps: [] } } };
  const sdk = { host: { state: { connectionId: atom('local'), profile: atom('main'),
    focusedSessionOwner: atom(null), focusedStoredSessionId: atom('chat') }, paneVisibility: () => atom(true) },
  useValue: value => value.get(), Button: 'button', Badge: 'span', LogView: 'pre',
  queryClient: { getQueryData: key => cache.get(JSON.stringify(key)), removeQueries() {}, invalidateQueries() {} },
  useQuery: options => {
    queries.push(options);
    const key = options.queryKey;
    const data = key.includes('connection') ? { connection_id: 'local', profile: 'main', source_id: 'source', csrf: 'fixture' }
      : key.includes('tickets') ? { tickets: [] } : key.includes('snapshot') ? snapshot
        : key.includes('events') ? { events: [] } : cache.get(JSON.stringify(key));
    return { data, isError: false, isLoading: Boolean(options.enabled && !data), refetch() {} };
  } };
  globalThis.__yerPatchHooks = hooks; globalThis.__yerPatchSdk = sdk;
  const url = value => 'data:text/javascript,' + encodeURIComponent(value);
  const code = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
    .replace("from '@hermes/plugin-sdk'", 'from ' + JSON.stringify(url(
      'export const { host, useValue, useQuery, queryClient, Button, Badge, LogView } = globalThis.__yerPatchSdk;')))
    .replace("from 'react'", 'from ' + JSON.stringify(url(
      'export const { createElement, useState, useEffect, useRef } = globalThis.__yerPatchHooks;')));
  const plugin = await import(url(code));
  const requests = []; let contribution;
  plugin.default.register({ register: value => { contribution = value; }, storage: {
    get: () => ({ source_id: 'source', ticket_id: 'ticket' }), set() {},
  }, rest: async route => { requests.push(route);
    return { file_id: 'file', revision: 'after-edit', state: 'available', patch: '+ NEW CONTENT' }; } });
  const walk = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(walk)];
  const hasText = (tree, value) => walk(tree).some(node => node.children.some(child => typeof child === 'string' && child.includes(value)));
  const render = () => {
    cursor = 0; refCursor = 0; queries = []; effects = [];
    const outer = contribution.render(), tree = outer.type(outer.props);
    for (const effect of effects) effect();
    return tree;
  };
  const patchQuery = () => queries.find(query => query.queryKey.includes('patch'));
  render(); let tree = render();
  walk(tree).find(node => node.type === 'button' && node.children.includes('unstaged · changed.txt')).props.onClick();
  render();
  const oldKey = patchQuery().queryKey;
  cache.set(JSON.stringify(oldKey), { file_id: 'file', revision: 'before-edit', state: 'available', patch: '+ OLD CONTENT' });
  assert.ok(hasText(render(), '+ OLD CONTENT'));

  snapshot = { ...snapshot, changes: { current: { ...snapshot.changes.current, files: [
    { ...snapshot.changes.current.files[0], revision: 'after-edit' },
  ] } } };
  tree = render();
  const next = patchQuery();
  assert.ok(next.enabled);
  assert.notDeepEqual(next.queryKey, oldKey);
  assert.equal(next.queryKey.at(-1), 'after-edit');
  assert.equal(hasText(tree, '+ OLD CONTENT'), false);
  assert.ok(hasText(tree, '过期'));
  cache.set(JSON.stringify(next.queryKey), cache.get(JSON.stringify(oldKey)));
  assert.equal(hasText(render(), '+ OLD CONTENT'), false);
  cache.set(JSON.stringify(next.queryKey), await next.queryFn({}));
  assert.match(requests.at(-1), /file_id=file&revision=after-edit&mode=current/);
  assert.ok(hasText(render(), '+ NEW CONTENT'));

  snapshot = { ...snapshot, changes: { current: { ...snapshot.changes.current, files: [] } } };
  tree = render();
  assert.equal(patchQuery().enabled, false);
  assert.equal(hasText(tree, '+ OLD CONTENT'), false);
  assert.equal(hasText(tree, '+ NEW CONTENT'), false);
  assert.ok(hasText(tree, '过期'));
  delete globalThis.__yerPatchHooks; delete globalThis.__yerPatchSdk;
});
