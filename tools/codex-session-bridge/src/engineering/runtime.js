import { RuntimeStore } from '../store.js';
import { SessionManager } from '../manager.js';
import { ModelCatalog } from '../catalog.js';
import { CodexExecutor } from '../executor.js';
import { PermissionResolver } from '../permissions.js';
import { createHarnessRuntime } from '../harness/runtime.ts';
import { FileImplementationLaunchAuthoritySource } from '../orchestration/implementation-launcher.ts';
import { FileReviewLaunchAuthoritySource } from '../orchestration/review-launcher.ts';
import { FileWorkflowAgentAuthoritySource } from '../orchestration/workflow-agent-launcher.ts';
import { FileExecutionAuthority } from '../orchestration/execution-authority.ts';
import { BridgeError, publicError } from '../errors.js';
import { EngineeringTaskHost } from './task-host.js';
import { EngineeringAuthority } from './authority.js';
import { EngineeringProjection } from './projection.js';

// Same RuntimeStore and journal owner as YCA. Use an independent fixture runtime
// until an explicitly authorized takeover has reconciled the old writer.
export function createEngineeringRuntime({ runtime, roots, codex = 'codex', pwsh,
  authorityFiles = {}, adapterId, profile, catalog, executor, permissionResolver, processAdapters } = {}) {
  let store, manager, taskHost;
  try {
    store = new RuntimeStore(runtime);
    manager = new SessionManager({ store, allowedCwds: roots, catalog: catalog ?? new ModelCatalog(codex),
      executor: executor ?? new CodexExecutor(codex), permissionResolver: permissionResolver ?? new PermissionResolver(codex) });
    for (const [key, Source] of [['implementationLaunchAuthority', FileImplementationLaunchAuthoritySource],
      ['reviewLaunchAuthority', FileReviewLaunchAuthoritySource], ['workflowAgentAuthority', FileWorkflowAgentAuthoritySource],
      ['executionAuthority', FileExecutionAuthority]])
      manager[key] = authorityFiles[key] ? new Source(authorityFiles[key], { forbiddenRoots: roots }) : null;
    taskHost = new EngineeringTaskHost({ roots, runtime, pwsh, processAdapters });
    manager.harness = createHarnessRuntime(manager, [], taskHost.tasks);
    manager.engineering = new EngineeringAuthority(manager, taskHost, { adapterId, profile });
    manager.engineeringProjection = new EngineeringProjection(manager, manager.engineering);
  } catch (error) {
    // Assembly has not dispatched processes. Preserve the failed journal bytes.
    manager?.harness?.close();
    store?.close();
    throw error;
  }
  return { manager, taskHost, async close() {
    manager.closing = true; taskHost.closing = true; manager.harness.computerCalls.closing = true;
    const results = await Promise.allSettled([taskHost.close(), manager.stopRuns(), manager.harness.computerCalls.drain()]);
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [{ source: ['engineering-tasks', 'codex', 'legacy-recording'][index], error: publicError(result.reason) }] : []);
    if (failures.length) throw new BridgeError('STOP_FAILED', 'Retain runtime writer until every process/output source is closed.', { failures });
    await manager.close();
  } };
}
