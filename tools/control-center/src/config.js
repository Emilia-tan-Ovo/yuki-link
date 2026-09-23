import path from 'node:path';
import { readJson, fail } from './common.js';
export function loadConfig(file) {
  const c = readJson(file);
  if (c.version !== 1 || typeof c.observeOnly !== 'boolean' || typeof c.allowStartupChanges !== 'boolean') throw fail('CONFIG_INVALID');
  for (const p of [c.stateDir, c.node, c.pwsh, c.codex, c.yca?.entry, c.yca?.cwd, c.yca?.repo, c.yca?.runtime, c.tunnel?.bin, c.tunnel?.profile, c.tunnel?.stateRoot]) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw fail('ABSOLUTE_PATH_REQUIRED');
  }
  const ports = [c.port, c.yca.port, c.yca.controlPort, ...(c.yca.harnessPort === undefined ? [] : [c.yca.harnessPort])];
  for (const p of [c.yca.deploymentRoot, c.yca.implementationLaunchAuthority, c.yca.reviewLaunchAuthority]) {
    if (p !== undefined && (typeof p !== 'string' || !path.isAbsolute(p))) throw fail('ABSOLUTE_PATH_REQUIRED');
  }
  if ([c.node, c.pwsh, c.codex, c.tunnel.bin].some(p => /\.(cmd|bat|ps1)$/i.test(p))) throw fail('NATIVE_EXECUTABLE_REQUIRED');
  if (new Set(ports).size !== ports.length || ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535)) throw fail('PORT_CONFIG_INVALID');
  if (c.tunnel.alias !== 'codex-session-bridge' || c.tunnel.target !== `http://127.0.0.1:${c.yca.port}/mcp`) throw fail('TOPOLOGY_CHANGED');
  return c;
}
