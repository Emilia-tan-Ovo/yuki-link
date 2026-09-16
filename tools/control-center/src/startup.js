import { fileURLToPath } from 'node:url';
import { run, fail } from './common.js';
export class Startup {
  constructor(config, file) { this.config = config; this.file = file; this.result = { state: '未检查' }; }
  snapshot() { return { ...this.result, changesAllowed: this.config.allowStartupChanges }; }
  async invoke(action) {
    const r = await run(this.config.pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../scripts/Startup.ps1', import.meta.url)), '-Action', action, '-Config', this.file], { timeout: 15_000 });
    if (r.code !== 0) throw fail('STARTUP_ACTION_FAILED');
    this.result = JSON.parse(r.output); return this.result;
  }
  async refresh() { try { await this.invoke('Status'); } catch { this.result = { state: '不可观测' }; } }
  async change(action) {
    if (!this.config.allowStartupChanges) throw fail('STARTUP_CONFIRMATION_REQUIRED');
    if (!['Install', 'Enable', 'Disable', 'Uninstall'].includes(action)) throw fail('INVALID_ACTION');
    await this.invoke(action);
  }
}
