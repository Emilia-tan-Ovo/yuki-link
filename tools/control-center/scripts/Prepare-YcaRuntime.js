import { parseArgs } from 'node:util';
import { prepareDeployment, selectDeployment } from '../src/deployment.js';

try {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, root: { type: 'string' }, node: { type: 'string' },
    'npm-cli': { type: 'string' }, select: { type: 'string' },
  } });
  if (!values.root || (!values.repo && !values.select)) throw Object.assign(new Error(), { code: 'DEPLOYMENT_ARGUMENTS_REQUIRED' });
  const result = values.select
    ? await selectDeployment(values.root, values.select, values.node)
    : await prepareDeployment({ repo: values.repo, root: values.root, node: values.node, npmCli: values['npm-cli'] });
  // No remote URL, credentials, config contents or child output are printed.
  console.log(JSON.stringify({ commit: result.commit, branch: result.branch, entry: result.entry, cwd: result.cwd,
    tools: result.tools, dependencies: result.dependencies, activation: 'next-explicit-yca-start' }, null, 2));
} catch (e) {
  console.error(/^[A-Z][A-Z0-9_]{1,79}$/.test(e.code ?? '') ? e.code : 'DEPLOYMENT_FAILED');
  process.exitCode = 1;
}
