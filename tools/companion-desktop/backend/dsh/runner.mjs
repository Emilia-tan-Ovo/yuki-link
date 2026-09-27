import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const VERSION = '0.1.0-rc.6';
const patch = fileURLToPath(new URL('./companion.patch.yml',import.meta.url));
const absoluteFile = value => { if (!path.isAbsolute(value) || !statSync(value).isFile()) throw Error('DSH executable path invalid'); return realpathSync(value); };
const absoluteDirectory = value => { if (!path.isAbsolute(value) || !statSync(value).isDirectory()) throw Error('DSH directory path invalid'); return realpathSync(value); };
const manifest = file => JSON.parse(readFileSync(file,'utf8'));
const jsExpression = new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:value=>value});
const dumpSchema = yaml.DEFAULT_SCHEMA.extend([jsExpression]);
const rows = value => Array.isArray(value) ? value.flatMap(rows)
  : value && typeof value === 'object' ? [value,...Object.values(value).flatMap(rows)] : [];

export function validateComposition(output, packageDirectory) {
  const base = yaml.load(readFileSync(path.join(packageDirectory,'..','dsh-base','cordis.patch.yml'),'utf8'),{schema:dumpSchema});
  const headless = yaml.load(readFileSync(path.join(packageDirectory,'..','dsh-headless','cordis.patch.yml'),'utf8'),{schema:dumpSchema});
  const known = new Map(rows([base,headless]).filter(row=>row.id && row.name).map(row=>[row.id,row.name]));
  const composed = yaml.load(output,{schema:dumpSchema});
  if (!Array.isArray(composed)) throw Error('DSH composition unavailable');
  const seen = new Set(); let mcp = 0;
  for (const row of composed) {
    if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || seen.has(row.id)) throw Error('DSH composition ambiguous');
    seen.add(row.id);
    if (row.id === 'yuki-companion-mcp') {
      if (row.name !== '@deepseek-ai/dsh-mcp-client' || row.disabled || row.config?.toolCallTimeoutMs !== 120_000) throw Error('DSH companion tool unavailable');
      mcp++; continue;
    }
    if (known.get(row.id) !== row.name) throw Error('DSH profile contains an unapproved plugin');
    if (row.id === 'agent-default-model' && (row.disabled === true
      || row.config?.provider !== 'process.env.YUKI_COMPANION_DSH_PROVIDER'
      || row.config?.model !== 'process.env.YUKI_COMPANION_DSH_MODEL'))
      throw Error('DSH explicit model selection unavailable');
    if ((row.id.startsWith('tool-') && row.id !== 'tool-result-pruner'
      || ['code-runtime','settings','subagent','subagent-spawn-in-process','subagent-fork-in-process','workflow-worker-thread'].includes(row.id))
      && row.disabled !== true) throw Error('DSH profile exposes an unapproved tool');
  }
  if (mcp !== 1 || !seen.has('headless-runner') || !seen.has('agent-default-model'))
    throw Error('DSH companion composition incomplete');
}

export function validateDshConfig(config) {
  if (!config || config.schema_version !== 1 || typeof config.provider !== 'string' || !/^[a-z][\w-]{1,63}$/u.test(config.provider)
    || typeof config.model !== 'string' || !/^[A-Za-z0-9._:-]{2,100}$/u.test(config.model)) throw Error('DSH model selection invalid');
  const node = absoluteFile(config.node), home = absoluteDirectory(config.home), packageDirectory = absoluteDirectory(config.packageDirectory);
  const bin = absoluteFile(path.join(packageDirectory,'lib','bin.js'));
  if (manifest(path.join(packageDirectory,'package.json')).version !== VERSION
    || manifest(path.join(packageDirectory,'..','dsh-base','package.json')).version !== VERSION
    || manifest(path.join(packageDirectory,'..','dsh-headless','package.json')).version !== VERSION
    || manifest(path.join(packageDirectory,'..','dsh-mcp-client','package.json')).version !== VERSION)
    throw Error('DSH pinned version mismatch');
  const url = new URL(config.ycaUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/companion-mcp'
    || url.search || url.hash || url.username || url.password) throw Error('YCA companion endpoint invalid');
  return { node, home, bin, provider: config.provider, model: config.model, ycaUrl: url.href };
}

const collect = (child, maxBytes = 8192, timeoutMs = 300_000) => new Promise((resolve,reject) => {
  let output = '', error = '', finished = false;
  const timeout = setTimeout(() => { child.kill(); reject(Error('DSH turn timed out; outcome unknown')); },timeoutMs);
  const take = (part,chunk) => { if (Buffer.byteLength(part) + chunk.length > maxBytes) { child.kill(); clearTimeout(timeout); reject(Error('DSH output limit exceeded')); return part; } return part + chunk.toString('utf8'); };
  child.stdout.on('data',chunk => { output = take(output,chunk); });
  child.stderr.on('data',chunk => { error = take(error,chunk); });
  child.once('error',error => { clearTimeout(timeout); reject(error); });
  child.once('close',code => { clearTimeout(timeout); if (!finished) { finished = true; resolve({ code, output, error }); } });
});

export async function runCompanionTurn(config, input, { spawnImpl = spawn } = {}) {
  const selected = validateDshConfig(config);
  const env = { ...process.env, DSH_HOME: selected.home,
    YUKI_COMPANION_DSH_PROVIDER: selected.provider, YUKI_COMPANION_DSH_MODEL: selected.model,
    YUKI_COMPANION_MCP_URL: selected.ycaUrl, DSH_TOOLS_MODE: 'native' };
  const task = `请只调用 mcp__companion__dispatch_confirmed_engineering_card，参数严格为 ${JSON.stringify(input)}。随后调用 mcp__companion__get_companion_engineering_receipt 读取同一标识。仅汇报 typed receipt 中已观察到的状态，不将本轮文本或退出码当作工程完成。`;
  const dump = spawnImpl(selected.node,[selected.bin,'--profile','headless','--patch',patch,'--dump-config'],
    {cwd:selected.home,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const composition = await collect(dump,256 * 1024,20_000);
  if (composition.code !== 0) throw Error('DSH composition preflight failed');
  validateComposition(composition.output,config.packageDirectory);
  // A configured package reference is re-resolved on every turn; no cache path is baked into the app.
  const startedAt = new Date().toISOString();
  const child = spawnImpl(selected.node,[selected.bin,'--profile','headless','--patch',patch,task],
    { cwd: selected.home, env, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  const outcome = await collect(child);
  return { state: outcome.code === 0 ? 'turn-completed' : 'turn-failed', exit_code: outcome.code,
    process_id: child.pid ?? null, started_at: startedAt, finished_at: new Date().toISOString(),
    session_id: null, turn_id: null,
    // Headless stdout is a conversational summary only; it is never parsed as a receipt.
    summary: outcome.output.slice(0,2000) };
}
