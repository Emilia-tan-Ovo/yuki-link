// Adapted from AAAAGENT desktop/electron/transport.mjs at the pinned revision.
// The generation boundary is retained; Electron utilityProcess supplies the
// packaged Node runtime instead of spawning a system Node executable.

export class BackendConnection {
  constructor({ worker, onMessage, fork }) { this.worker = worker; this.onMessage = onMessage; this.fork = fork; this.generation = 0; this.child = null; this.state = 'disconnected'; }
  start(config) {
    this.close();
    const generation = ++this.generation;
    this.state = 'connecting';
    const child = this.fork(this.worker, [], { stdio: 'ignore', serviceName: 'Yuki Link Text Backend' });
    this.child = child;
    child.on('message', message => {
      if (generation !== this.generation) return;
      if (message?.type === 'ready') this.state = 'ready';
      this.onMessage(message, generation);
    });
    child.on('exit', () => {
      if (generation !== this.generation) return;
      this.child = null; this.state = 'disconnected';
      this.onMessage({ type: 'disconnected' }, generation);
    });
    child.postMessage({ type: 'start', ...config, generation });
  }
  send(message, generation) {
    if (this.state !== 'ready' || generation !== this.generation || !this.child) return false;
    this.child.postMessage({ ...message, generation }); return true;
  }
  close() {
    ++this.generation;
    const child = this.child; this.child = null; this.state = 'disconnected';
    if (!child) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.on('message', message => { if (message?.type === 'closed') { child.kill(); resolve(); } });
      child.postMessage({ type: 'close' });
    });
  }
}
