import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const now = () => Date.now();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const fail = code => Object.assign(new Error(code), { code });
export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw fail('STATE_UNREADABLE'); }
}
export function saveJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flush: true, mode: 0o600 });
  renameSync(temporary, file);
}
export function claimStateDirectory(directory, port, configFile) {
  const file = path.join(directory, 'binding.json'), expected = { port, configFile };
  try { writeFileSync(file, JSON.stringify(expected), { encoding: 'utf8', flag: 'wx', flush: true }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; if (JSON.stringify(readJson(file)) !== JSON.stringify(expected)) throw fail('STATE_BINDING_CONFLICT'); }
}
// Logs contain structured metadata only. Raw child output, request bodies, command
// lines and environment are deliberately excluded, including unknown error text.
export class Events {
  constructor(directory) {
    this.file = path.join(directory, 'events.jsonl'); this.items = []; mkdirSync(directory, { recursive: true });
    if (existsSync(this.file) && statSync(this.file).size <= 1024 * 1024) {
      this.items = readFileSync(this.file, 'utf8').split('\n').slice(-81).flatMap(line => {
        try {
          const e = JSON.parse(line);
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(e.operation_id ?? '')
            && ['requested', 'succeeded', 'failed'].includes(e.outcome)
            && /^[a-z][a-z0-9-]{1,39}$/.test(e.action ?? '') && ['yca', 'tunnel', 'all'].includes(e.target)) {
            return [{ at: new Date(e.at).toISOString(), operation_id: e.operation_id, action: e.action, target: e.target,
              outcome: e.outcome, code: /^[A-Z][A-Z0-9_]{1,79}$/.test(e.code ?? '') ? e.code : null }];
          }
          if (!Number.isFinite(Date.parse(e.at)) || !['yca', 'tunnel', 'supervisor', 'all'].includes(e.component)
            || !['process-exit', 'native-connect', 'ready', 'check-failed', 'started', 'stopped', 'start', 'stop', 'restart', 'retry', 'recovery-attempt', 'recovery-paused', 'recovery-failed', 'long-check-gap',
              'deployment-checked', 'deployment-check-failed', 'deployment-prepared', 'update-stopped-old', 'deployment-switched', 'deployment-rolled-back', 'deployment-rollback-failed', 'deployment-update-failed',
              'startup-reconciled', 'startup-reconciliation-failed'].includes(e.action)) return [];
          return [{ at: new Date(e.at).toISOString(), component: e.component, action: e.action, code: /^[A-Z][A-Z0-9_]{1,79}$/.test(e.code ?? '') ? e.code : null, exitCode: Number.isInteger(e.exitCode) ? e.exitCode : null }];
        } catch { return []; }
      });
    }
  }
  add(component, action, code = null, exitCode = null) {
    const safe = value => /^[a-zA-Z0-9_. -]{1,100}$/.test(value ?? '') ? value : null;
    const entry = { at: new Date().toISOString(), component: safe(component), action: safe(action), code: /^[A-Z][A-Z0-9_]{1,79}$/.test(code ?? '') ? code : null, exitCode: Number.isInteger(exitCode) ? exitCode : null };
    this.items.push(entry); this.items = this.items.slice(-80);
    if (existsSync(this.file) && statSync(this.file).size > 256 * 1024) renameSync(this.file, this.file + '.1');
    appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
  }
  addOperation(operationId, action, target, outcome, code = null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId ?? '')
      || !/^[a-z][a-z0-9-]{1,39}$/.test(action ?? '') || !['yca', 'tunnel', 'all'].includes(target)
      || !['requested', 'succeeded', 'failed'].includes(outcome)) throw fail('INVALID_OPERATION');
    const entry = { at: new Date().toISOString(), operation_id: operationId, action, target, outcome,
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(code ?? '') ? code : null };
    if (existsSync(this.file) && statSync(this.file).size > 256 * 1024) renameSync(this.file, this.file + '.1');
    appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    this.items.push(entry); this.items = this.items.slice(-80);
  }
}
export function run(executable, args, { cwd, env = process.env, timeout = 5000, input = '', limit = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, problem; const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => { problem = fail('COMMAND_TIMEOUT'); child.kill(); child.stdout.destroy(); child.stderr.destroy(); reject(problem); }, timeout);
    child.stdout.on('data', b => { bytes += b.length; if (bytes <= limit) output += decoder.write(b); else { problem = fail('OUTPUT_LIMIT'); child.kill(); child.stdout.destroy(); child.stderr.destroy(); reject(problem); } });
    child.stderr.resume(); // Never publish raw CLI output; may contain authentication material.
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.once('error', e => { clearTimeout(timer); reject(fail(e.code === 'ENOENT' ? 'PATH_MISSING' : 'SPAWN_FAILED')); });
    child.once('close', code => { clearTimeout(timer); if (problem) reject(problem); else resolve({ code, output: output + decoder.end() }); });
  });
}
export async function get(url, { token, method = 'GET', confirm = false, timeout = 2000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password) throw fail('NON_LOOPBACK_URL');
  try {
    const response = await fetch(u, { method, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(confirm ? { 'x-confirm-impact': 'yes' } : {}),
    } });
    let body = ''; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > 256 * 1024) throw fail('OUTPUT_LIMIT'); body += Buffer.from(chunk).toString('utf8'); }
    let json; try { json = JSON.parse(body); } catch { /* text health */ }
    return { status: response.status, body, json };
  } catch (e) { throw fail(e.code === 'OUTPUT_LIMIT' ? e.code : 'LOCAL_PROBE_FAILED'); }
}
