import { Harness } from './harness.ts';
import { CodexSource } from './codex-source.ts';
import { createHarnessServer } from './server.ts';
import { TaskSource } from './task-source.ts';
import type { OwnedTaskReader } from './task-source.ts';

export function createHarnessRuntime(manager: ConstructorParameters<typeof CodexSource>[0], controlRoots: string[] = [], tasks?: OwnedTaskReader) {
  const harness = new Harness(manager.store.directory, new CodexSource(manager, controlRoots), tasks ? new TaskSource(tasks) : undefined);
  harness.start();
  return harness;
}
export { createHarnessServer };
