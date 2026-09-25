import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteMemoryStore } from '../backend/sqlite-memory.mjs';

async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'yuki-sqlite-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('v0 migrates in place, keeps old rows, and reopens v1 idempotently', async t => {
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
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
  store.close();
});

test('unknown future schema fails closed without changing data', async t => {
  const dir = await fixture(t);
  const store = new SqliteMemoryStore(dir); store.close();
  const db = new DatabaseSync(join(dir, 'conversation.sqlite'));
  db.exec('PRAGMA user_version = 2'); db.close();
  assert.throws(() => new SqliteMemoryStore(dir), /版本过高/);
  const check = new DatabaseSync(join(dir, 'conversation.sqlite'));
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2);
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
