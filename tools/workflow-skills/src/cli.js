import { parseArgs } from 'node:util';
import { preview, loadPlan, verifyPlan } from './plans.js';
import { apply } from './apply.js';
import { fail } from './files.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: 'string' }, target: { type: 'string' }, skills: { type: 'string' },
    plan: { type: 'string' }, approve: { type: 'string' },
  } });
  if (positionals.length !== 1) throw fail('INVALID_COMMAND');
  const accepted = { preview: ['repo', 'target', 'skills'], apply: ['plan', 'approve'], verify: ['plan'] }[positionals[0]];
  if (!accepted) throw fail('INVALID_COMMAND');
  if (Object.keys(values).some(key => !accepted.includes(key))) throw fail('INVALID_ARGUMENTS');
  let result;
  if (positionals[0] === 'preview') result = preview(values.repo, values.target, values.skills?.split(','));
  else if (positionals[0] === 'apply') result = apply(values.plan, values.approve);
  else if (positionals[0] === 'verify') result = verifyPlan(loadPlan(values.plan));
  else throw fail('INVALID_COMMAND');
  console.log(JSON.stringify(result));
  if (!['preview', 'verified'].includes(result.status)) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ status: 'error', error: { code: error.code ?? 'OPERATION_FAILED', ...(error.details ? { details: error.details } : {}) } }));
  process.exitCode = 1;
}
