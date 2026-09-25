import { readFile, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ROLE_CARD, normalizeRoleCard } from '../../backend/prompt-composer.mjs';

export class SettingsStore {
  constructor(file, committed, warning = '') { this.file = file; this.committed = committed; this.warning = warning; this.queue = Promise.resolve(); this.rename = rename; }
  static async load(file) {
    let saved = {};
    try { saved = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') return new SettingsStore(file, { workbenchUrl: '', roleCard: { ...DEFAULT_ROLE_CARD } }, '设置文件无法读取，已使用默认角色卡。'); }
    let roleCard = { ...DEFAULT_ROLE_CARD }, warning = '';
    if (saved && Object.hasOwn(saved, 'roleCard')) {
      try { roleCard = normalizeRoleCard(saved.roleCard); }
      catch { warning = '已保存的角色卡无效，当前使用默认角色卡。'; }
    }
    return new SettingsStore(file, { workbenchUrl: typeof saved?.workbenchUrl === 'string' ? saved.workbenchUrl : '', roleCard }, warning);
  }
  snapshot() { return { workbenchUrl: this.committed.workbenchUrl, roleCard: { ...this.committed.roleCard } }; }
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
