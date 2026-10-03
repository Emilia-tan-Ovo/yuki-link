import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WindowsMcpUnit } from '../src/windows-mcp-unit.js';
import { ProfileTunnelUnit } from '../src/profile-tunnel-unit.js';
import { Supervisor } from '../src/supervisor.js';

for (const [name, Unit] of [['Windows MCP', WindowsMcpUnit], ['profile tunnel', ProfileTunnelUnit]]) {
  test(`${name} ignores a late old-child exit after PID reuse and records the current child exit`, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'yuki-cc-exit-identity-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const children = [], forwarded = [];
    let launches = 0, present = false, current = null;
    const host = {
      inspect: async () => present ? [current] : [],
      free: async () => { if (present) throw Error('PORT_CONFLICT'); },
    };
    const options = {
      spawnProcess: () => {
        launches++;
        present = true;
        current = { pid: 7777, created: launches === 1 ? 'old-creation' : 'new-creation', matches: true };
        const child = new EventEmitter();
        child.pid = current.pid;
        child.unref = () => {};
        children.push(child);
        setImmediate(() => child.emit('spawn'));
        return child;
      },
      probe: async () => ({ healthy: true, serverName: 'windows-mcp', serverVersion: 'test' }),
    };
    const config = Unit === WindowsMcpUnit
      ? { python: process.execPath, port: 8123 }
      : { bin: process.execPath, profile: path.join(root, 'profile'), profileSha256: 'test', stateDir: root };
    const id = Unit === WindowsMcpUnit ? 'windowsMcp' : 'windowsTunnel';
    const stateFile = path.join(root, 'state.json');
    let unit;
    const supervisor = new Supervisor({ stateFile, events: { add() {} }, createUnits: (state, persist) => {
      unit = new Unit(config, host, state.units[id].ownership,
        change => { if (change?.unitExit) forwarded.push(change.unitExit); persist(change); }, { add() {} }, options);
      return { yca: { config: {} }, [id]: unit };
    } });
    const state = supervisor.state.units[id].ownership;
    if (Unit === ProfileTunnelUnit) {
      unit.verifyProfile = () => {};
      unit.verifyVersion = async () => {};
      unit.observe = async () => ({ running: present, owned: present, healthy: present });
    }
    await supervisor.withMutationLock(() => unit.start());
    present = false;
    await supervisor.withMutationLock(() => unit.start());
    children[0].emit('exit', 9);
    await supervisor.tail;
    assert.equal(state.process.created, 'new-creation');
    assert.equal(state.lastExit, undefined);
    assert.equal(forwarded.length, 0);
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).units[id].ownership.lastExit, undefined);
    children[1].emit('exit', 0);
    await supervisor.tail;
    assert.equal(state.lastExit.exitCode, 0);
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0].process, { pid: 7777, created: 'new-creation' });
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).units[id].ownership.lastExit.exitCode, 0);
  });
}
