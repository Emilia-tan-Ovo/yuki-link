import { Harness } from './harness.ts';
import { CodexSource } from './codex-source.ts';
import { createHarnessServer } from './server.ts';

export function createHarnessRuntime(manager: ConstructorParameters<typeof CodexSource>[0], controlRoots: string[] = []) {
  const harness = new Harness(manager.store.directory, new CodexSource(manager, controlRoots));
  harness.start();
  return harness;
}
export { createHarnessServer };
