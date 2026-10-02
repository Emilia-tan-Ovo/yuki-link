import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './common.js';

const schemaTables = {
  5: ['cards', 'card_revisions', 'card_dispatches', 'card_work_stops'],
  6: ['card_entry_previews', 'card_entry_actions', 'card_confirmation_origins',
    'card_result_subscriptions', 'card_result_events', 'card_result_deliveries', 'card_preparation_consumptions'],
};

export function inspectCardDatabase(directory) {
  if (!directory) return { version: null, path: null, configured: false };
  const file = path.join(directory, 'engineering-cards.sqlite');
  if (!existsSync(file)) return { version: 0, path: file, configured: true };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (!Number.isInteger(version) || version < 0) throw fail('DB_STRUCTURE_INVALID');
    for (const [minimum, tables] of Object.entries(schemaTables)) {
      if (version < Number(minimum)) continue;
      for (const table of tables) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw fail('DB_STRUCTURE_INVALID');
      }
    }
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (Object.values(integrity)[0] !== 'ok') throw fail('DB_STRUCTURE_INVALID');
    return { version, path: file, configured: true };
  } catch (error) {
    if (error?.code === 'DB_STRUCTURE_INVALID') throw error;
    throw fail('DB_STRUCTURE_INVALID');
  } finally { db?.close(); }
}

export function assertCardCompatibility(contract, database) {
  if (!contract || !Number.isInteger(contract.minimumReadable) || !Number.isInteger(contract.maximumReadable)
      || !Number.isInteger(contract.migrationTarget) || contract.relativePath !== 'engineering-cards.sqlite'
      || contract.minimumReadable < 0 || contract.maximumReadable < contract.minimumReadable
      || contract.migrationTarget > contract.maximumReadable) throw fail('DB_CONTRACT_INVALID');
  if (!database.configured) return;
  if (database.version < contract.minimumReadable || database.version > contract.maximumReadable) throw fail('DB_SCHEMA_UNSUPPORTED');
}
