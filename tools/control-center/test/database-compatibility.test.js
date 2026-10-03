import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { EngineeringCardStore } from '../../companion-desktop/backend/engineering-card-store.mjs';
import { inspectCardDatabase, assertCardCompatibility } from '../src/database-compatibility.js';

test('schema preflight is read-only and refuses a v5 binary against v6 cards', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yuki-card-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new EngineeringCardStore(directory); store.close();
  const database = inspectCardDatabase(directory);
  assert.equal(database.version, 6);
  const oldContract = { minimumReadable: 0, maximumReadable: 5, migrationTarget: 5,
    relativePath: 'engineering-cards.sqlite' };
  assert.throws(() => assertCardCompatibility(oldContract, database), { code: 'DB_SCHEMA_UNSUPPORTED' });
  assert.doesNotThrow(() => assertCardCompatibility({ ...oldContract, maximumReadable: 6, migrationTarget: 6 }, database));
  const db = new DatabaseSync(path.join(directory, 'engineering-cards.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6); }
  finally { db.close(); }
});
