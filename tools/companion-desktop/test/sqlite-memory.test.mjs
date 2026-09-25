import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteMemoryStore } from '../backend/sqlite-memory.mjs';

async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'yuki-sqlite-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('v0 migrates in place, keeps old rows, and reopens v2 idempotently', async t => {
  const dir = await fixture(t);
  const db = new DatabaseSync(join(dir, 'conversation.sqlite'));
  db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, turn_id TEXT NOT NULL)");
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('old', 'assistant', '旧回复', '2026-01-01', 'turn');
  db.close();
  let store = new SqliteMemoryStore(dir);
  assert.deepEqual(store.history(), [{ role: 'assistant', text: '旧回复' }]);
  assert.equal(store.displayHistory()[0].reasoningContent, null);
  store.appendTurn([{ id: 'new', role: 'assistant', text: '新回复', createdAt: '2026-01-02', turnId: 'turn2', reasoningContent: 'MARKER', metadata: { source: 'deepseek', reasoningTruncated: false } }]);
  assert.equal(store.history().some(row => JSON.stringify(row).includes('MARKER')), false);
  store.close();
  store = new SqliteMemoryStore(dir);
  assert.equal(store.displayHistory()[1].reasoningContent, 'MARKER');
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  store.close();
});

test('unknown future schema fails closed without changing data', async t => {
  const dir = await fixture(t);
  const store = new SqliteMemoryStore(dir); store.close();
  const db = new DatabaseSync(join(dir, 'conversation.sqlite'));
  db.exec('PRAGMA user_version = 3'); db.close();
  assert.throws(() => new SqliteMemoryStore(dir), /版本过高/);
  const check = new DatabaseSync(join(dir, 'conversation.sqlite'));
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3);
  check.close();
});

test('appendTurn rolls back both rows if assistant insert fails', async t => {
  const dir = await fixture(t);
  const store = new SqliteMemoryStore(dir);
  const row = (id, role) => ({ id, role, text: role, createdAt: '2026-01-01', turnId: 'turn' });
  assert.throws(() => store.appendTurn([row('same', 'user'), row('same', 'assistant')]));
  assert.deepEqual(store.displayHistory(), []);
  store.close();
});

test('displayHistory keeps rows and reasoning when stored metadata is malformed or outside the whitelist', async t => {
  const dir = await fixture(t);
  const store = new SqliteMemoryStore(dir);
  const values = ['{broken', '[]', '"text"', '{"privateToken":"secret"}', '{"requestedThinking":12}', '{"source":"deepseek","requestedThinking":"high","reasoningTruncated":false}'];
  const insert = store.db.prepare("INSERT INTO messages (id,role,text,created_at,turn_id,reasoning_content,response_metadata) VALUES (?,'assistant','回答','2026-01-01','turn','保留思考',?)");
  values.forEach((value, index) => insert.run(String(index), value));
  const rows = store.displayHistory();
  assert.equal(rows.length, values.length);
  assert.ok(rows.every(row => row.text === '回答' && row.reasoningContent === '保留思考'));
  assert.deepEqual(rows.slice(0, -1).map(row => row.metadata), [null, null, null, null, null]);
  assert.deepEqual(rows.at(-1).metadata, { source: 'deepseek', requestedThinking: 'high', reasoningTruncated: false });
  assert.deepEqual(store.db.prepare('SELECT response_metadata FROM messages ORDER BY rowid').all().map(row => row.response_metadata), values);
  store.close();
});

test('v1 migrates to v2, correction and forgetting cut model history while keeping display history', async t => {
  const dir = await fixture(t);
  const db = new DatabaseSync(join(dir, 'conversation.sqlite'));
  db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, turn_id TEXT NOT NULL, reasoning_content TEXT, response_metadata TEXT); PRAGMA user_version = 1");
  db.prepare("INSERT INTO messages VALUES ('old','user','我喜欢红茶','2026-01-01','turn',NULL,NULL)").run(); db.close();
  let store = new SqliteMemoryStore(dir);
  const first = store.remember({ text: '我喜欢红茶', sourceKind: 'selected_user_message', sourceRef: 'old' });
  assert.equal(store.recall('红茶怎么样').entries[0].id, first.id);
  const replacement = store.correct(first.id, '我喜欢绿茶');
  assert.equal(store.history().length, 0);
  assert.equal(store.displayHistory().length, 1);
  assert.equal(store.db.prepare('SELECT text FROM companion_memories WHERE id=?').get(first.id).text, null);
  assert.equal(store.recall('红茶怎么样').entries.length, 0);
  assert.equal(store.recall('绿茶怎么样').entries[0].id, replacement.id);
  store.close(); store = new SqliteMemoryStore(dir);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(store.listMemories()[0].id, replacement.id);
  store.forget(replacement.id);
  assert.deepEqual(store.listMemories(), []);
  assert.equal(store.db.prepare('SELECT text FROM companion_memories WHERE id=?').get(replacement.id).text, null);
  assert.throws(() => store.forget(first.id), /已失效/);
  store.close();
});

test('memory mutation rolls back text and cutoff if transaction fails', async t => {
  const store = new SqliteMemoryStore(await fixture(t));
  const entry = store.remember({ text: '喜欢红茶', sourceKind: 'explicit_chat' });
  store.db.exec("CREATE TRIGGER fail_context BEFORE UPDATE ON companion_context BEGIN SELECT RAISE(ABORT, 'fail'); END");
  assert.throws(() => store.correct(entry.id, '喜欢绿茶'), /fail/);
  assert.equal(store.listMemories()[0].text, '喜欢红茶');
  assert.equal(store.db.prepare('SELECT recent_context_after_rowid AS cutoff FROM companion_context').get().cutoff, 0);
  store.close();
});

test('recall is active-only, relevant and bounded to five stable entries', async t => {
  const store = new SqliteMemoryStore(await fixture(t));
  for (let index = 0; index < 8; index++) store.remember({ text: `喜欢红茶类型${index}`, sourceKind: 'explicit_chat' });
  store.remember({ text: '喜欢蓝色', sourceKind: 'explicit_chat' });
  const result = store.recall('红茶推荐');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.entries.length, 5);
  assert.ok(result.entries.every(entry => entry.text.includes('红茶')));
  assert.deepEqual(store.recall('天气').entries, []);
  store.close();
});
