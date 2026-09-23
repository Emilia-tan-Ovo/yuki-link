import path from 'node:path';
import { CONTEXT_PLAN_TEMPLATE } from '../src/orchestration/context-plan-contract.ts';
import { MarkdownContextDocumentAdapter } from '../src/orchestration/document-adapter.ts';

if (process.argv[2] === '--template') {
  process.stdout.write(CONTEXT_PLAN_TEMPLATE);
} else {
  const file = process.argv[2];
  if (!file || !path.isAbsolute(file)) throw new Error('Supply an absolute Implementation Notes path.');
  const fact = new MarkdownContextDocumentAdapter().read(path.dirname(file), path.basename(file), 'implementation-notes');
  if (fact.status !== 'observed' || !fact.context_plan) throw new Error(`CONTEXT_PLAN_${fact.status.toUpperCase().replaceAll('-', '_')}`);
  process.stdout.write('CONTEXT_PLAN_OBSERVED\n');
}
