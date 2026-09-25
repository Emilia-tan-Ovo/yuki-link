import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class SqliteMemoryStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'conversation.sqlite'));
    this.db.exec('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN (\'user\',\'assistant\')), text TEXT NOT NULL, created_at TEXT NOT NULL, turn_id TEXT NOT NULL)');
  }
  history() { return this.db.prepare('SELECT id, role, text, created_at AS createdAt, turn_id AS turnId FROM messages ORDER BY rowid').all(); }
  appendTurn(rows) {
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT INTO messages (id,role,text,created_at,turn_id) VALUES (?,?,?,?,?)');
      for (const row of rows) insert.run(row.id, row.role, row.text, row.createdAt, row.turnId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
