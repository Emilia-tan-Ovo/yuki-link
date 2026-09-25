import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../desktop/electron/settings-store.mjs';
import { DEFAULT_ROLE_CARD } from '../backend/prompt-composer.mjs';
import { submittedTurn } from '../desktop/electron/submit-snapshot.mjs';
import { DEFAULT_THINKING } from '../desktop/electron/settings-store.mjs';
import { DEFAULT_VOICE } from '../desktop/voice-config.mjs';

async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'yuki-settings-')); t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, 'settings.json'); }

test('versioned voice settings serialize with other settings and roll back failed save', async t => {
  const file = await fixture(t), store = await SettingsStore.load(file);
  assert.deepEqual(store.snapshot().voice, DEFAULT_VOICE);
  const voice = { ...DEFAULT_VOICE, enabled: true };
  await Promise.all([store.saveVoice(voice), store.saveRoleCard({ schemaVersion: 1, text: '保留角色卡' }), store.saveThinking({ schemaVersion: 1, enabled: true, effort: 'high' })]);
  assert.equal(store.snapshot().roleCard.text, '保留角色卡'); assert.equal(store.snapshot().thinking.enabled, true);
  assert.deepEqual((await SettingsStore.load(file)).snapshot().voice, voice);
  const before = await readFile(file, 'utf8'); store.rename = async () => { throw Error('rename failed'); };
  await assert.rejects(store.saveVoice({ ...voice, enabled: false })); assert.equal(await readFile(file, 'utf8'), before); assert.equal(store.snapshot().voice.enabled, true);
  assert.throws(() => store.saveVoice({ ...voice, provider: 'arbitrary' }));
});

test('legacy settings use default card and invalid saved card warns', async t => {
  const file = await fixture(t);
  await writeFile(file, JSON.stringify({ workbenchUrl: 'http://127.0.0.1:1234/' }));
  const store = await SettingsStore.load(file);
  assert.deepEqual(store.snapshot().roleCard, DEFAULT_ROLE_CARD);
  assert.equal(store.snapshot().workbenchUrl, 'http://127.0.0.1:1234/');
  assert.deepEqual(store.snapshot().thinking, DEFAULT_THINKING);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).thinking, undefined);
  await writeFile(file, JSON.stringify({ roleCard: { schemaVersion: 1, text: '' } }));
  assert.match((await SettingsStore.load(file)).warning, /角色卡/);
});

test('persona and workbench writes serialize without losing either field', async t => {
  const file = await fixture(t);
  const store = await SettingsStore.load(file);
  await Promise.all([store.saveRoleCard({ schemaVersion: 1, text: '卡 B' }), store.saveWorkbenchUrl('http://127.0.0.1:1234/')]);
  assert.equal(store.snapshot().roleCard.text, '卡 B');
  assert.equal(store.snapshot().workbenchUrl, 'http://127.0.0.1:1234/');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), store.snapshot());
  assert.deepEqual((await SettingsStore.load(file)).snapshot(), store.snapshot());
  await store.resetRoleCard();
  assert.deepEqual(store.snapshot().roleCard, DEFAULT_ROLE_CARD);
  assert.equal(store.snapshot().workbenchUrl, 'http://127.0.0.1:1234/');
});

test('failed rename retains old committed snapshot and old settings file', async t => {
  const file = await fixture(t);
  const store = await SettingsStore.load(file);
  await store.saveRoleCard({ schemaVersion: 1, text: '卡 A' });
  const before = await readFile(file, 'utf8');
  store.rename = async () => { throw Error('rename failed'); };
  await assert.rejects(store.saveRoleCard({ schemaVersion: 1, text: '卡 B' }), /rename failed/);
  assert.equal(store.snapshot().roleCard.text, '卡 A');
  assert.equal(await readFile(file, 'utf8'), before);
});

test('accepted submit captures A while save B is pending; next submit captures B', async t => {
  const file = await fixture(t);
  const store = await SettingsStore.load(file);
  await store.saveRoleCard({ schemaVersion: 1, text: '卡 A' });
  let release;
  const original = store.rename;
  store.rename = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  const saving = store.saveRoleCard({ schemaVersion: 1, text: '卡 B' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const first = submittedTurn({ id: 'T1', text: '你好' }, store);
  release();
  await saving;
  const second = submittedTurn({ id: 'T2', text: '再见' }, store);
  assert.equal(first.roleCard.text, '卡 A');
  assert.equal(second.roleCard.text, '卡 B');
});

test('thinking validates, persists effort while off, and freezes accepted submit', async t => {
  const file = await fixture(t);
  const store = await SettingsStore.load(file);
  assert.throws(() => store.saveThinking({ schemaVersion: 1, enabled: true, effort: 'medium' }), /思考设置/);
  await store.saveThinking({ schemaVersion: 1, enabled: true, effort: 'max' });
  let release;
  const rename = store.rename;
  store.rename = async (...args) => { await new Promise(resolve => { release = resolve; }); return rename(...args); };
  const saving = store.saveThinking({ schemaVersion: 1, enabled: false, effort: 'max' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const first = submittedTurn({ id: 'A', text: '问' , thinking: { enabled: false, effort: 'low' } }, store);
  release(); await saving;
  const second = submittedTurn({ id: 'B', text: '问' }, store);
  assert.deepEqual(first.thinking, { schemaVersion: 1, enabled: true, effort: 'max' });
  assert.deepEqual(second.thinking, { schemaVersion: 1, enabled: false, effort: 'max' });
  assert.deepEqual((await SettingsStore.load(file)).snapshot().thinking, second.thinking);
});

test('failed thinking save keeps committed snapshot; next successful save and reopen use new value', async t => {
  const file = await fixture(t);
  const store = await SettingsStore.load(file);
  await store.saveThinking({ schemaVersion: 1, enabled: true, effort: 'low' });
  const before = await readFile(file, 'utf8');
  const rename = store.rename;
  store.rename = async () => { throw Error('rename failed'); };
  await assert.rejects(store.saveThinking({ schemaVersion: 1, enabled: true, effort: 'max' }), /rename failed/);
  assert.deepEqual(store.snapshot().thinking, { schemaVersion: 1, enabled: true, effort: 'low' });
  assert.equal(await readFile(file, 'utf8'), before);
  store.rename = rename;
  await store.saveThinking({ schemaVersion: 1, enabled: false, effort: 'low' });
  assert.deepEqual(store.snapshot().thinking, { schemaVersion: 1, enabled: false, effort: 'low' });
  assert.deepEqual((await SettingsStore.load(file)).snapshot().thinking, store.snapshot().thinking);
});
