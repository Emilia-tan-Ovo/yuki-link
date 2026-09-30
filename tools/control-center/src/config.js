import path from 'node:path';
import { readJson, fail } from './common.js';
export function loadConfig(file) {
  const c = readJson(file);
  if (c.version !== 1 || typeof c.observeOnly !== 'boolean' || typeof c.allowStartupChanges !== 'boolean') throw fail('CONFIG_INVALID');
  for (const p of [c.stateDir, c.node, c.pwsh, c.codex, c.yca?.entry, c.yca?.cwd, c.yca?.repo, c.yca?.runtime,
    c.tunnel?.bin, c.tunnel?.profile, c.tunnel?.stateRoot, c.windowsMcp?.python,
    c.windowsTunnel?.bin, c.windowsTunnel?.profile, c.windowsTunnel?.stateDir]) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw fail('ABSOLUTE_PATH_REQUIRED');
  }
  const ports = [c.port, c.yca.port, c.yca.controlPort, ...(c.yca.harnessPort === undefined ? [] : [c.yca.harnessPort]), c.windowsMcp.port];
  for (const p of [c.yca.deploymentRoot, c.yca.implementationLaunchAuthority, c.yca.reviewLaunchAuthority, c.yca.workflowAgentAuthority, c.yca.executionAuthority, c.yca.companionCardStore]) {
    if (p !== undefined && (typeof p !== 'string' || !path.isAbsolute(p))) throw fail('ABSOLUTE_PATH_REQUIRED');
  }
  if ([c.node, c.pwsh, c.codex, c.tunnel.bin, c.windowsMcp.python, c.windowsTunnel.bin].some(p => /\.(cmd|bat|ps1)$/i.test(p))) throw fail('NATIVE_EXECUTABLE_REQUIRED');
  if (new Set(ports).size !== ports.length || ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535)) throw fail('PORT_CONFIG_INVALID');
  if (c.tunnel.alias !== 'codex-session-bridge' || c.tunnel.target !== `http://127.0.0.1:${c.yca.port}/mcp`) throw fail('TOPOLOGY_CHANGED');
  if (c.windowsTunnel.target !== `http://127.0.0.1:${c.windowsMcp.port}/mcp` || !/^[0-9a-f]{64}$/.test(c.windowsTunnel.profileSha256 ?? '')) throw fail('TOPOLOGY_CHANGED');
  return c;
}
