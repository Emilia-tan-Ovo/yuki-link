import { readFile, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ROLE_CARD, normalizeRoleCard } from '../../backend/prompt-composer.mjs';
import { DEFAULT_VOICE, migrateSavedVoice, normalizeVoice } from '../voice-config.mjs';
import { DEFAULT_LIVE2D, normalizeLive2D } from './live2d-config.mjs';
export const DEFAULT_THINKING = Object.freeze({ schemaVersion: 1, enabled: false, effort: 'high' });
export function normalizeThinking(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !['low', 'high', 'max'].includes(value.effort)) throw Error('思考设置无效。');
  return { schemaVersion: 1, enabled: value.enabled, effort: value.effort };
}

export class SettingsStore {
  constructor(file, committed, warning = '') { this.file = file; this.committed = committed; this.warning = warning; this.queue = Promise.resolve(); this.rename = rename; }
  static async load(file) {
    let saved = {};
    try { saved = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') return new SettingsStore(file, { workbenchUrl: '', roleCard: { ...DEFAULT_ROLE_CARD }, thinking: { ...DEFAULT_THINKING } }, '设置文件无法读取，已使用默认设置。'); }
    let roleCard = { ...DEFAULT_ROLE_CARD }, warning = '';
    if (saved && Object.hasOwn(saved, 'roleCard')) {
      try { roleCard = normalizeRoleCard(saved.roleCard); }
      catch { warning = '已保存的角色卡无效，当前使用默认角色卡。'; }
    }
    let thinking = { ...DEFAULT_THINKING };
    if (saved && Object.hasOwn(saved, 'thinking')) {
      try { thinking = normalizeThinking(saved.thinking); }
      catch { warning += ' 已保存的思考设置无效，当前使用默认设置。'; }
    }
    let voice = { ...DEFAULT_VOICE };
    if (saved && Object.hasOwn(saved, 'voice')) { try { voice = migrateSavedVoice(saved.voice); } catch { warning += ' 已保存的语音设置无效，已停用。'; } }
    let live2d = { ...DEFAULT_LIVE2D };
    if (saved && Object.hasOwn(saved, 'live2d')) { try { live2d = normalizeLive2D(saved.live2d); } catch { warning += ' 已保存的 Live2D 配置无效，已停用。'; } }
    return new SettingsStore(file, { workbenchUrl: typeof saved?.workbenchUrl === 'string' ? saved.workbenchUrl : '', roleCard, thinking, voice, live2d }, warning.trim());
  }
  snapshot() { return { workbenchUrl: this.committed.workbenchUrl, roleCard: { ...this.committed.roleCard }, thinking: { ...this.committed.thinking }, voice: { ...(this.committed.voice ?? DEFAULT_VOICE) }, live2d: structuredClone(this.committed.live2d ?? DEFAULT_LIVE2D) }; }
  saveLive2D(value) { const live2d = normalizeLive2D(value); return this.commit(current => ({ ...current, live2d })); }
  saveVoice(value) { const voice = normalizeVoice(value); return this.commit(current => ({ ...current, voice })); }
  saveThinking(value) { const thinking = normalizeThinking(value); return this.commit(current => ({ ...current, thinking })); }
  saveRoleCard(value) { const card = normalizeRoleCard(value); return this.commit(current => ({ ...current, roleCard: card })); }
  resetRoleCard() { return this.saveRoleCard(DEFAULT_ROLE_CARD); }
  saveWorkbenchUrl(value) { return this.commit(current => ({ ...current, workbenchUrl: value })); }
  commit(update) {
    const operation = this.queue.then(async () => {
      const candidate = update(this.snapshot());
      const temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(candidate), 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await this.rename(temporary, this.file);
        this.committed = candidate;
        this.warning = '';
        return this.snapshot();
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
