const { spawn } = require('node:child_process');

const mode = process.argv[2];
if (mode === 'parent') {
  const child = spawn(process.execPath, [__filename, 'child'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  console.log(JSON.stringify({ kind: 'parent', pid: process.pid, child: child.pid }));
  child.on('exit', code => { process.exitCode = code; });
} else {
  let n = 0;
  console.log(JSON.stringify({ kind: mode, pid: process.pid }));
  setInterval(() => console.log(JSON.stringify({ kind: mode, n: ++n })), 200);
}
