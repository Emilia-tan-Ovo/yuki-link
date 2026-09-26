import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const exe = resolve('dist/win-unpacked/Yuki Link Desktop.exe');
const data = await mkdtemp(join(tmpdir(), 'yuki-packaged-smoke-'));
const pwsh = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).Path'], { encoding: 'utf8', windowsHide: true }).trim();
const cleanEnv = { ...process.env, PATH: [dirname(pwsh), process.env.SystemRoot + '\\System32', process.env.SystemRoot].join(';') };
delete cleanEnv.ELECTRON_RUN_AS_NODE;
delete cleanEnv.NODE_OPTIONS;
const run = phase => new Promise((resolveRun, reject) => {
  let output = '';
  const child = spawn(exe, ['--smoke-test', '--smoke-data', data, '--smoke-phase', phase], {
    cwd: tmpdir(), windowsHide: true,
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const timer = setTimeout(() => { child.kill(); reject(Error('Packaged smoke timed out: ' + output)); }, 30000);
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('exit', code => { clearTimeout(timer); const live2dPending = phase === 'voice-credential' || output.includes('YUKI_LIVE2D_ACTUAL_PENDING sdk/model/draw/talking'); if (code === 0 && live2dPending && output.includes(`YUKI_PACKAGED_SMOKE_OK phase=${phase}`)) resolveRun(output.trim()); else reject(Error(`Packaged smoke ${phase} failed (${code}): ${output}`)); });
});
try { console.log(await run('first')); console.log(await run('reopen')); console.log(await run('voice-credential')); }
finally { await rm(data, { recursive: true, force: true }); }
