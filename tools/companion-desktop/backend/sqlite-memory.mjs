import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const validText = value => typeof value === 'string' && !!value.trim() && value.trim().length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value);
function memoryText(value) {
  if (!validText(value)) throw Error('陪伴记忆请输入不超过 300 字的有效文本。');
  return value.trim();
}
function terms(value) {
  const parts = value.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? [];
  const result = new Set();
  for (const part of parts) {
    if (/^[a-z0-9]+$/u.test(part)) { if (part.length >= 2) result.add(part); }
    else for (let i = 0; i < part.length - 1; i++) result.add(part.slice(i, i + 2));
  }
  return result;
}

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
      this.db.exec('PRAGMA foreign_keys = ON');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 2) throw Error('对话数据库版本过高，当前版本无法读取。');
      const exists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
      const columns = exists ? this.db.prepare('PRAGMA table_info(messages)').all().map(row => row.name) : [];
      const base = ['id', 'role', 'text', 'created_at', 'turn_id'];
      if (exists && base.some(name => !columns.includes(name))) throw Error('对话数据库结构不受支持。');
      if (version >= 1 && (!exists || !['reasoning_content', 'response_metadata'].every(name => columns.includes(name)))) throw Error('对话数据库版本与结构不一致。');
      if (version === 0 && columns.some(name => ['reasoning_content', 'response_metadata'].includes(name))) throw Error('对话数据库版本与结构不一致。');
      const memoryExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companion_memories'").get();
      const contextExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companion_context'").get();
      if ((version < 2 && (memoryExists || contextExists)) || (version === 2 && (!memoryExists || !contextExists || !exists))) throw Error('对话数据库版本与结构不一致。');
      if (version === 0) {
        this.db.exec('BEGIN');
        try {
          if (!exists) this.db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created_at TEXT NOT NULL, turn_id TEXT NOT NULL, reasoning_content TEXT, response_metadata TEXT)");
          else this.db.exec('ALTER TABLE messages ADD COLUMN reasoning_content TEXT; ALTER TABLE messages ADD COLUMN response_metadata TEXT');
          this.db.exec('PRAGMA user_version = 1; COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      if (version < 2) {
        this.db.exec('BEGIN');
        try {
          this.db.exec("CREATE TABLE companion_memories (id TEXT PRIMARY KEY, text TEXT, topic TEXT, state TEXT NOT NULL CHECK(state IN ('active','superseded','forgotten')), source_kind TEXT NOT NULL CHECK(source_kind IN ('explicit_chat','selected_user_message')), source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 100), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, supersedes_id TEXT REFERENCES companion_memories(id), CHECK((state='active' AND text IS NOT NULL AND length(trim(text)) BETWEEN 1 AND 300) OR (state<>'active' AND text IS NULL AND topic IS NULL))); CREATE INDEX companion_memories_active ON companion_memories(state, updated_at, id); CREATE INDEX companion_memories_supersedes ON companion_memories(supersedes_id); CREATE TABLE companion_context (singleton INTEGER PRIMARY KEY CHECK(singleton=1), recent_context_after_rowid INTEGER NOT NULL CHECK(recent_context_after_rowid>=0)); INSERT INTO companion_context VALUES (1,0); PRAGMA user_version = 2; COMMIT");
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      } else {
        const memoryColumns = this.db.prepare('PRAGMA table_info(companion_memories)').all().map(row => row.name);
        const contextColumns = this.db.prepare('PRAGMA table_info(companion_context)').all().map(row => row.name);
        const memorySql = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='companion_memories'").get().sql;
        const contextSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='companion_context'").get().sql;
        if (['id','text','topic','state','source_kind','source_ref','created_at','updated_at','supersedes_id'].some(name => !memoryColumns.includes(name)) || !['singleton','recent_context_after_rowid'].every(name => contextColumns.includes(name)) || !memorySql.includes("CHECK((state='active' AND text IS NOT NULL AND length(trim(text)) BETWEEN 1 AND 300)") || !contextSql.includes('CHECK(recent_context_after_rowid>=0)') || !this.db.prepare('SELECT 1 FROM companion_context WHERE singleton=1').get() || this.db.prepare('SELECT COUNT(*) AS n FROM companion_context').get().n !== 1) throw Error('对话数据库版本与结构不一致。');
      }
    } catch (error) { this.db.close(); throw error; }
  }
  history() { return this.db.prepare('SELECT role, text FROM messages WHERE rowid > (SELECT recent_context_after_rowid FROM companion_context WHERE singleton=1) ORDER BY rowid').all().map(row => ({ role: row.role, text: row.text })); }
  listMemories() { return this.db.prepare("SELECT id,text,source_kind AS sourceKind,source_ref AS sourceRef,created_at AS createdAt,updated_at AS updatedAt FROM companion_memories WHERE state='active' ORDER BY updated_at DESC,id").all(); }
  recall(query) {
    const queryTerms = terms(query);
    if (!queryTerms.size) return { schemaVersion: 1, entries: [] };
    const candidates = this.listMemories().map(row => ({ row, score: [...terms(row.text)].filter(term => queryTerms.has(term)).length })).filter(item => item.score > 0);
    candidates.sort((a,b) => b.score - a.score || b.row.updatedAt.localeCompare(a.row.updatedAt) || a.row.id.localeCompare(b.row.id));
    const entries = []; let budget = 0;
    for (const { row } of candidates) {
      if (entries.length === 5) break;
      const sourceRef = row.sourceKind + ':' + row.sourceRef;
      const cost = row.id.length + row.text.length + sourceRef.length;
      if (budget + cost > 4000) continue;
      entries.push({ id: row.id, text: row.text, sourceRef }); budget += cost;
    }
    return { schemaVersion: 1, entries };
  }
  transaction(fn) { this.db.exec('BEGIN'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  remember({ text, sourceKind, sourceRef } = {}) {
    const clean = memoryText(text);
    if (!['explicit_chat','selected_user_message'].includes(sourceKind)) throw Error('陪伴记忆来源无效。');
    if (sourceKind === 'selected_user_message' && (typeof sourceRef !== 'string' || !this.db.prepare("SELECT 1 FROM messages WHERE id=? AND role='user'").get(sourceRef))) throw Error('请选择已保存的用户消息。');
    const ref = sourceKind === 'explicit_chat' ? randomUUID() : sourceRef;
    const id = randomUUID(), now = new Date().toISOString();
    this.transaction(() => this.db.prepare("INSERT INTO companion_memories (id,text,topic,state,source_kind,source_ref,created_at,updated_at,supersedes_id) VALUES (?,?,NULL,'active',?,?,?,?,NULL)").run(id,clean,sourceKind,ref,now,now));
    return { id, text: clean, sourceKind, sourceRef: ref, createdAt: now, updatedAt: now };
  }
  change(id, text) {
    if (typeof id !== 'string') throw Error('请选择有效的陪伴记忆。');
    const clean = text === null ? null : memoryText(text);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM companion_memories WHERE id=?').get(id);
      if (!old || old.state !== 'active') throw Error('这条陪伴记忆已失效，请重新选择。');
      const now = new Date().toISOString(), nextId = clean === null ? null : randomUUID();
      this.db.prepare('UPDATE companion_memories SET text=NULL,topic=NULL,state=?,updated_at=? WHERE id=?').run(clean === null ? 'forgotten' : 'superseded',now,id);
      if (nextId) this.db.prepare("INSERT INTO companion_memories (id,text,topic,state,source_kind,source_ref,created_at,updated_at,supersedes_id) VALUES (?,?,NULL,'active','explicit_chat',?,?,?,?)").run(nextId,clean,randomUUID(),now,now,id);
      this.db.prepare('UPDATE companion_context SET recent_context_after_rowid=max(recent_context_after_rowid,(SELECT coalesce(max(rowid),0) FROM messages)) WHERE singleton=1').run();
      return nextId ? { id: nextId, text: clean, sourceKind: 'explicit_chat', updatedAt: now, supersedesId: id } : { id, state: 'forgotten' };
    });
  }
  correct(id, text) { return this.change(id, text); }
  forget(id) { return this.change(id, null); }
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
