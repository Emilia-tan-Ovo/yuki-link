import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateModelResources } from '../desktop/electron/live2d-resources.mjs';
import { SettingsStore } from '../desktop/electron/settings-store.mjs';
import { Live2DResources } from '../desktop/electron/live2d-runtime.mjs';
import { OptionalLive2D, checkTextureBudget } from '../desktop/live2d-loader.mjs';
import { assetResponse } from '../desktop/electron/assets.mjs';
import { runInNewContext } from 'node:vm';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'yuki-live2d-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Synthetic file contracts only: these bytes are NOT a loadable Cubism model.
  const model = { Version: 3, FileReferences: { Moc: 'body.moc3', Textures: ['body.png'] }, Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: ['Mouth'] }] };
  await writeFile(join(root, 'body.moc3'), ''); await writeFile(join(root, 'body.png'), '');
  const save = () => writeFile(join(root, 'avatar.model3.json'), JSON.stringify(model));
  await save(); return { root, entry: 'avatar.model3.json', model, save };
}
test('synthetic minimal manifest without optional motion verifies file contract only', async t => {
  const f = await fixture(t), result = await validateModelResources(f);
  assert.equal(result.resourcesVerified, true); assert.equal(result.modelLoaded, false);
  assert.equal(result.mouthCandidate, 'Mouth'); assert.equal(result.mouthReady, false);
  assert.equal(result.declarationCount, 2); assert.equal(result.files.length, 3);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal((await validateModelResources(f)).revision, result.revision);
});
test('all declared optional references are validated; duplicate declarations hit the pre-read cap', async t => {
  const f = await fixture(t);
  f.model.FileReferences.Expressions = Array.from({ length: 255 }, (_, i) => ({ Name: String(i), File: 'face.exp3.json' }));
  await f.save(); await assert.rejects(validateModelResources(f), { code: 'RESOURCE_BUDGET' });
  f.model.FileReferences.Expressions.length = 254;
  await writeFile(join(f.root, 'face.exp3.json'), '{}'); await f.save();
  const result = await validateModelResources(f); assert.equal(result.declarationCount, 256); assert.equal(result.files.length, 4);
  f.model.FileReferences = { ...f.model.FileReferences, Expressions: [], Physics: 'body.physics3.json', Pose: 'body.pose3.json', UserData: 'body.userdata3.json', DisplayInfo: 'body.cdi3.json', Motions: { Idle: [{ File: 'idle.motion3.json' }] } };
  for (const name of ['body.physics3.json','body.pose3.json','body.userdata3.json','body.cdi3.json','idle.motion3.json']) await writeFile(join(f.root, name), '{}');
  await f.save(); assert.equal((await validateModelResources(f)).declarationCount, 7);
  await rm(join(f.root, 'idle.motion3.json')); await assert.rejects(validateModelResources(f), { code: 'RESOURCE_MISSING' });
});
test('unsafe paths, unknown references and incorrect manifest structures fail closed', async t => {
  const f = await fixture(t);
  for (const path of ['../body.moc3', '/body.moc3', 'C:/body.moc3', '\\\\server\\body.moc3', 'sub\\body.moc3', './body.moc3', '%2e%2e/body.moc3', 'body\0.moc3', 'body:secret.moc3', 'https://site/body.moc3']) {
    f.model.FileReferences.Moc = path; await f.save();
    await assert.rejects(validateModelResources(f), e => e.code === 'RESOURCE_PATH_INVALID' && !e.message.includes(f.root));
  }
  f.model.FileReferences.Moc = 'body.moc3'; f.model.FileReferences.Script = 'bad.js'; await f.save();
  await assert.rejects(validateModelResources(f), { code: 'REFERENCE_TYPE_UNKNOWN' });
  delete f.model.FileReferences.Script; f.model.FileReferences.Motions = { Idle: [{ File: 'x.motion3.json', Sound: 'sound.wav' }] }; await f.save();
  await assert.rejects(validateModelResources(f), { code: 'REFERENCE_TYPE_UNKNOWN' });
  delete f.model.FileReferences.Motions; f.model.FileReferences.Textures = []; await f.save();
  await assert.rejects(validateModelResources(f), { code: 'MODEL_SCHEMA_INVALID' });
});
test('missing files, directories and junction escape are rejected without private paths', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'body.moc3')); await assert.rejects(validateModelResources(f), { code: 'RESOURCE_MISSING' });
  await mkdir(join(f.root, 'body.moc3')); await assert.rejects(validateModelResources(f), { code: 'RESOURCE_FILE_TYPE' });
  await rm(join(f.root, 'body.moc3'), { recursive: true }); await writeFile(join(f.root, 'body.moc3'), '');
  const outside = await mkdtemp(join(tmpdir(), 'yuki-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'escape.moc3'), '');
  await symlink(outside, join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  f.model.FileReferences.Moc = 'link/escape.moc3'; await f.save();
  await assert.rejects(validateModelResources(f), { code: 'RESOURCE_REPARSE' });
  await assert.rejects(validateModelResources({ ...f, root: join(f.root, 'link') }), { code: 'RESOURCE_REPARSE' });
});
test('bad JSON and JSON/moc/texture-count/total budgets reject before loading', async t => {
  const f = await fixture(t), entry = join(f.root, f.entry);
  await writeFile(entry, '{'); await assert.rejects(validateModelResources(f), { code: 'MODEL_JSON_INVALID' });
  await writeFile(entry, ' '.repeat(1024 * 1024 + 1)); await assert.rejects(validateModelResources(f), { code: 'RESOURCE_BUDGET' });
  await f.save(); const moc = await open(join(f.root, 'body.moc3'), 'w'); await moc.truncate(64 * 1024 * 1024 + 1); await moc.close();
  await assert.rejects(validateModelResources(f), { code: 'RESOURCE_BUDGET' }); await writeFile(join(f.root, 'body.moc3'), '');
  f.model.FileReferences.Textures = Array(33).fill('body.png'); await f.save(); await assert.rejects(validateModelResources(f), { code: 'RESOURCE_BUDGET' });
  f.model.FileReferences.Textures = ['body.png']; await f.save(); const texture = await open(join(f.root, 'body.png'), 'w'); await texture.truncate(256 * 1024 * 1024); await texture.close();
  await assert.rejects(validateModelResources(f), { code: 'RESOURCE_BUDGET' });
});
test('texture changes invalidate pinned fingerprint and mouth candidates never imply actual mapping', async t => {
  const f = await fixture(t), first = await validateModelResources(f);
  await writeFile(join(f.root, 'body.png'), 'changed synthetic bytes');
  await assert.rejects(validateModelResources({ ...f, expectedRevision: first.revision }), { code: 'RESOURCE_CHANGED' });
  assert.notEqual((await validateModelResources(f)).revision, first.revision);
  f.model.Groups = []; await f.save(); assert.equal((await validateModelResources(f)).mouthCandidate, null);
  f.model.Groups = [{ Target: 'Parameter', Name: 'LipSync', Ids: ['A','B'] }]; await f.save();
  assert.equal((await validateModelResources(f)).mouthCandidate, null);
  const mapped = await validateModelResources({ ...f, mouth: { parameterId: 'Explicit', closed: 0, open: 1 } });
  assert.equal(mapped.mouthCandidate, 'Explicit'); assert.equal(mapped.mouthReady, false);
});
test('main resource selection exposes only safe facts; changed bytes and revoked URLs are denied', async t => {
  const f = await fixture(t), settings = await SettingsStore.load(join(f.root, 'settings.json')), resources = new Live2DResources({ settings });
  assert.equal(resources.snapshot().configured, false); assert.equal(resources.snapshot().ready, false);
  await resources.select(join(f.root, f.entry)); const selected = resources.snapshot();
  assert.equal(selected.configured, true); assert.equal(selected.resourcesVerified, true); assert.equal(selected.sdkLoaded, false);
  assert.equal(selected.drawReady, false); assert.equal(selected.mouthMapped, false); assert.equal(selected.ready, false);
  assert.equal(JSON.stringify(selected).includes(f.root), false);
  assert.equal((await resources.read(selected.resourceId, selected.revision, 'body.png')).length, 0);
  await writeFile(join(f.root, 'body.png'), 'changed');
  await assert.rejects(resources.read(selected.resourceId, selected.revision, 'body.png'), { code: 'RESOURCE_CHANGED' });
  assert.equal(resources.snapshot().resourcesVerified, false);
  await resources.disable(); assert.equal(resources.snapshot().configured, false);
  await assert.rejects(resources.read(selected.resourceId, selected.revision, 'body.png'), { code: 'RESOURCE_REVOKED' });
  for (const url of ['yuki://model/body.png', 'yuki://sdk/core.js', 'yuki://app/C:/private/file']) assert.ok((await assetResponse(f.root, url)).status >= 400);
});
test('revoke fences a late validation and failed disable retains committed settings', async t => {
  const f = await fixture(t), settings = await SettingsStore.load(join(f.root, 'settings.json'));
  const manifest = await validateModelResources(f); let finish;
  const resources = new Live2DResources({ settings, validate: () => new Promise(r => { finish = r; }) });
  const selecting = resources.select(join(f.root, f.entry)); await resources.disable(); finish(manifest); await selecting;
  assert.equal(settings.snapshot().live2d.model, null); assert.equal(resources.snapshot().ready, false);
  const normal = new Live2DResources({ settings }); await normal.select(join(f.root, f.entry));
  const old = settings.snapshot().live2d; settings.rename = async () => { throw Error('private path'); };
  await assert.rejects(normal.disable(), /LIVE2D_SAVE_FAILED/); assert.deepEqual(settings.snapshot().live2d, old);
});
test('optional loader never executes unreviewed SDK code and synthetic adapter evidence stays synthetic', async () => {
  let imports = 0, disposed = 0, release;
  const live = new OptionalLive2D();
  assert.equal((await live.load({ configured: false })).ready, false);
  assert.equal((await live.load({ configured: true, resourcesVerified: true, sdkConfigured: true, entrypoint: 'evil.js' })).code, 'SDK_UNREVIEWED');
  const wiring = new OptionalLive2D({ syntheticLoader: async () => { imports++; await new Promise(r => { release = r; }); return { dispose: () => { disposed++; } }; } });
  const pending = wiring.load({ configured: true, resourcesVerified: true, sdkConfigured: false });
  wiring.dispose(); release(); const result = await pending;
  assert.equal(imports, 1); assert.equal(disposed, 1); assert.equal(result.ready, false); assert.equal(result.sdkLoaded, false);
  assert.equal(result.evidence, 'synthetic-code-wiring');
});
test('texture decode admission enforces RGBA and actual GPU limits without implying successful decoding', () => {
  assert.equal(checkTextureBudget([{ width: 1024, height: 1024 }], 4096), true);
  assert.throws(() => checkTextureBudget([{ width: 8192, height: 8192 }, { width: 1, height: 1 }], 8192), /TEXTURE_BUDGET/);
  assert.throws(() => checkTextureBudget([{ width: 4097, height: 1 }], 4096), /TEXTURE_BUDGET/);
  assert.throws(() => checkTextureBudget([{ width: 1, height: 1 }], undefined), /TEXTURE_BUDGET/);
});
test('model selection IPC accepts only trusted native picker results and never renderer paths', async () => {
  const source = await readFile(new URL('../desktop/electron/main.mjs', import.meta.url), 'utf8');
  const handlers = new Map(), selected = [], notices = []; let trusted = false, prompts = 0, published = 0;
  const avatar = { epoch: 0, select: async file => { selected.push(file); return true; }, snapshot: () => ({ ready: false }) };
  runInNewContext(source.slice(source.indexOf("ipcMain.on('yuki:live2d-select'"), source.indexOf("ipcMain.on('yuki:live2d-disable'")), {
    ipcMain: { on: (name, callback) => handlers.set(name, callback) }, trusted: () => trusted, win: {}, avatar,
    dialog: { showOpenDialog: async () => { prompts++; return { canceled: false, filePaths: ['native-selected.model3.json'] }; } },
    deliver: value => notices.push(value), publishAvatar: () => { published++; }
  });
  const choose = handlers.get('yuki:live2d-select');
  choose({}, { path: 'renderer-supplied-private-path' }); await new Promise(r => setImmediate(r)); assert.equal(prompts, 0);
  trusted = true; choose({}, { path: 'renderer-supplied-private-path' }); await new Promise(r => setImmediate(r));
  assert.deepEqual(selected, ['native-selected.model3.json']); assert.equal(prompts, 1); assert.ok(published > 0);
  assert.equal(JSON.stringify(notices).includes('native-selected'), false);
});
