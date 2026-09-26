import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const schema = `CREATE TABLE cards (card_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','confirmed','revoked')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE card_revisions (card_id TEXT NOT NULL REFERENCES cards(card_id), revision INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(card_id,revision));
CREATE TABLE card_confirmations (card_id TEXT NOT NULL REFERENCES cards(card_id), revision INTEGER NOT NULL, confirmed_at TEXT NOT NULL, action_source TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(card_id,revision));
CREATE TABLE card_observations (card_id TEXT PRIMARY KEY REFERENCES cards(card_id), workflow TEXT, updated_at TEXT NOT NULL);
CREATE INDEX cards_recent ON cards(updated_at DESC);`;
const parse = value => value === null || value === undefined ? null : JSON.parse(value);
const now = () => new Date().toISOString();
const confirmable = content => content && typeof content.original === 'string' && content.original.trim() && content.projectKey && content.repository && ['verified_existing','explicit_new_requirement'].includes(content.resolution?.status) && (content.resolution.status !== 'verified_existing' || content.ticket?.url) && content.desiredPhase && ['design-only','to-pr'].includes(content.endpoint) && content.extraAuthorization?.merge === false && content.extraAuthorization?.deploy === false;

export class EngineeringCardStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'engineering-cards.sqlite'));
    try {
      this.db.exec('PRAGMA foreign_keys=ON');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw Error('工程卡片数据库版本过高。');
      if (version === 0) { this.db.exec('BEGIN IMMEDIATE'); try { this.db.exec(schema + ' PRAGMA user_version=1; COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
      for (const table of ['cards','card_revisions','card_confirmations','card_observations']) if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw Error('工程卡片数据库结构不完整。');
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  get(cardId) {
    const row = this.db.prepare('SELECT * FROM cards WHERE card_id=?').get(cardId);
    if (!row) return null;
    const content = this.db.prepare('SELECT content FROM card_revisions WHERE card_id=? AND revision=?').get(cardId,row.revision);
    const confirmation = this.db.prepare('SELECT revision,confirmed_at AS confirmedAt,action_source AS actionSource,content FROM card_confirmations WHERE card_id=? ORDER BY revision DESC LIMIT 1').get(cardId);
    const observation = this.db.prepare('SELECT workflow FROM card_observations WHERE card_id=?').get(cardId);
    return { cardId, revision: row.revision, state: row.state, content: parse(content.content), confirmation: confirmation ? { ...confirmation, content: parse(confirmation.content) } : null, observedWorkflow: parse(observation?.workflow), dispatchStatus: 'not-dispatched', createdAt: row.created_at, updatedAt: row.updated_at };
  }
  revision(cardId, revision) { const row = this.db.prepare('SELECT content,created_at AS createdAt FROM card_revisions WHERE card_id=? AND revision=?').get(cardId,revision); return row ? { cardId, revision, content: parse(row.content), createdAt: row.createdAt } : null; }
  list() { return this.db.prepare('SELECT card_id FROM cards ORDER BY updated_at DESC LIMIT 30').all().map(row => this.get(row.card_id)); }
  create(content) {
    if (!content || typeof content.original !== 'string' || !content.original.trim() || content.original.length > 20000) throw Error('工程要求无效。');
    const cardId = randomUUID(), time = now();
    return this.transaction(() => { this.db.prepare("INSERT INTO cards VALUES (?,1,'pending',?,?)").run(cardId,time,time); this.db.prepare('INSERT INTO card_revisions VALUES (?,1,?,?)').run(cardId,JSON.stringify(content),time); return this.get(cardId); });
  }
  edit(cardId, expectedRevision, content) {
    if (!content || typeof content.original !== 'string' || !content.original.trim() || content.original.length > 20000) throw Error('工程要求无效。');
    return this.transaction(() => { const current = this.get(cardId); if (!current) throw Error('工程卡片不存在。'); if (current.revision !== expectedRevision || current.state === 'revoked') return { conflict: true, card: current }; const revision = expectedRevision + 1, time = now(); this.db.prepare('INSERT INTO card_revisions VALUES (?,?,?,?)').run(cardId,revision,JSON.stringify(content),time); this.db.prepare("UPDATE cards SET revision=?,state='pending',updated_at=? WHERE card_id=?").run(revision,time,cardId); return this.get(cardId); });
  }
  confirm(cardId, expectedRevision, actionSource) {
    if (actionSource !== 'desktop-user-action') throw Error('工程卡片确认来源无效。');
    return this.transaction(() => { const current = this.get(cardId); if (!current) throw Error('工程卡片不存在。'); if (current.revision !== expectedRevision || current.state === 'revoked') return { conflict: true, card: current }; if (current.state === 'confirmed') return { card: current, confirmation: current.confirmation }; if (!confirmable(current.content)) return { invalid: true, card: current }; const time = now(); this.db.prepare('INSERT INTO card_confirmations VALUES (?,?,?,?,?)').run(cardId,expectedRevision,time,actionSource,JSON.stringify(current.content)); this.db.prepare("UPDATE cards SET state='confirmed',updated_at=? WHERE card_id=?").run(time,cardId); const card = this.get(cardId); return { card, confirmation: card.confirmation }; });
  }
  revoke(cardId, expectedRevision) { return this.transaction(() => { const current = this.get(cardId); if (!current) throw Error('工程卡片不存在。'); if (current.revision !== expectedRevision || current.state === 'revoked') return { conflict: true, card: current }; this.db.prepare("UPDATE cards SET state='revoked',updated_at=? WHERE card_id=?").run(now(),cardId); return { card: this.get(cardId) }; }); }
  observe(cardId, workflow) { return this.transaction(() => { if (!this.get(cardId)) throw Error('工程卡片不存在。'); this.db.prepare('INSERT INTO card_observations VALUES (?,?,?) ON CONFLICT(card_id) DO UPDATE SET workflow=excluded.workflow,updated_at=excluded.updated_at').run(cardId,workflow ? JSON.stringify(workflow) : null,now()); return this.get(cardId); }); }
  close() { this.db.close(); }
}
