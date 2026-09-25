import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const metadataKeys = new Set(['source', 'requestedThinking', 'requestModel', 'responseModel', 'fullResponseMs', 'finishReason', 'reasoningTruncated']);
function displayMetadata(value) {
  if (typeof value !== 'string') return null;
  try {
    const data = JSON.parse(value);
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(key => !metadataKeys.has(key))) return null;
    if ('source' in data && data.source !== null && data.source !== 'deepseek') return null;
    if ('requestedThinking' in data && !['off', 'low', 'high', 'max'].includes(data.requestedThinking)) return null;
    if (['requestModel', 'responseModel'].some(key => key in data && data[key] !== null && typeof data[key] !== 'string')) return null;
    if ('fullResponseMs' in data && data.fullResponseMs !== null && (!Number.isFinite(data.fullResponseMs) || data.fullResponseMs < 0)) return null;
    if ('finishReason' in data && data.finishReason !== null && data.finishReason !== 'stop') return null;
    if ('reasoningTruncated' in data && typeof data.reasoningTruncated !== 'boolean') return null;
    return Object.fromEntries(Object.entries(data));
  } catch { return null; }
}

export class SqliteMemoryStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'conversation.sqlite'));
    try {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw Error('对话数据库版本过高，当前版本无法读取。');
      const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
      const columns = exists ? this.db.prepare('PRAGMA table_info(messages)').all().map(row => row.name) : [];
      const base = ['id', 'role', 'text', 'created_at', 'turn_id'];
      if (exists && base.some(name => !columns.includes(name))) throw Error('对话数据库结构不受支持。');
      if (version === 1 && (!exists || !['reasoning_content', 'response_metadata'].every(name => columns.includes(name)))) throw Error('对话数据库版本与结构不一致。');
      if (version === 0 && columns.some(name => ['reasoning_content', 'response_metadata'].includes(name))) throw Error('对话数据库版本与结构不一致。');
      if (version === 0) {
        this.db.exec('BEGIN');
        try {
          if (!exists) this.db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, turn_id TEXT NOT NULL, reasoning_content TEXT, response_metadata TEXT)");
          else this.db.exec('ALTER TABLE messages ADD COLUMN reasoning_content TEXT; ALTER TABLE messages ADD COLUMN response_metadata TEXT');
          this.db.exec('PRAGMA user_version = 1; COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  history() { return this.db.prepare('SELECT role, text FROM messages ORDER BY rowid').all().map(row => ({ role: row.role, text: row.text })); }
  displayHistory() { return this.db.prepare('SELECT id, role, text, created_at AS createdAt, turn_id AS turnId, reasoning_content AS reasoningContent, response_metadata AS responseMetadata FROM messages ORDER BY rowid').all().map(row => ({ id: row.id, role: row.role, text: row.text, createdAt: row.createdAt, turnId: row.turnId, reasoningContent: row.reasoningContent, metadata: displayMetadata(row.responseMetadata) })); }
  appendTurn(rows) {
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT INTO messages (id,role,text,created_at,turn_id,reasoning_content,response_metadata) VALUES (?,?,?,?,?,?,?)');
      for (const row of rows) insert.run(row.id, row.role, row.text, row.createdAt, row.turnId, row.role === 'assistant' ? row.reasoningContent ?? null : null, row.role === 'assistant' && row.metadata ? JSON.stringify(row.metadata) : null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
