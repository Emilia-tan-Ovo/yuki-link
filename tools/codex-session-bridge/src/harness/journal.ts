import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redact } from '../errors.js';
import { HarnessError, recordSchema } from './model.ts';
import type { Operation, RecordEntry } from './model.ts';

// The owning RuntimeStore lock must already be held. No independent writer/lock.
export class Journal {
  file: string;
  records: RecordEntry[] = [];
  sourceId = randomUUID() as string;
  failure: string | null = null;
  constructor(runtime: string) {
    const directory = path.join(runtime, 'harness');
    this.file = path.join(directory, 'history.jsonl');
    try {
      if (existsSync(directory) && (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())) throw new Error('unsafe directory');
      mkdirSync(directory, { recursive: true });
      if (existsSync(this.file)) {
        const stat = lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe journal');
        const content = readFileSync(this.file, 'utf8');
        const lines = content.split('\n');
        for (const line of lines.slice(0, -1)) {
          const record = recordSchema.parse(JSON.parse(line));
          if (record.cursor !== this.records.length + 1
            || (this.records.length && record.source_id !== this.sourceId)
            || (this.records.length === 0 && record.data.kind !== 'source')) throw new Error('invalid journal sequence');
          this.sourceId = record.source_id;
          this.records.push(record);
        }
        if (lines.at(-1) !== '') throw new Error('incomplete tail');
      }
      if (!this.records.length) this.append({ kind: 'source' });
    } catch { this.failure = 'JOURNAL_INVALID_OR_UNAVAILABLE'; }
  }
  append(data: Operation): RecordEntry {
    if (this.failure) throw new HarnessError('RECORDING_FAILED', { reason: this.failure });
    const record = recordSchema.parse({
      schema_version: 1, cursor: this.records.length + 1, source_id: this.sourceId,
      event_id: randomUUID(), observed_at: new Date().toISOString(), data,
    });
    // All record fields, including user supplied labels and attribution metadata,
    // use the same best-effort policy as bridge output. No raw secret side copy.
    const serialized = JSON.stringify(record, (_key, value) => typeof value === 'string' ? redact(value) : value);
    const safe = recordSchema.parse(JSON.parse(serialized));
    try {
      appendFileSync(this.file, serialized + '\n', { encoding: 'utf8', flush: true });
    } catch {
      // A partial append is possible; freeze this writer until a checked restart.
      this.failure = 'JOURNAL_WRITE_FAILED';
      throw new HarnessError('RECORDING_FAILED', { reason: this.failure });
    }
    this.records.push(safe);
    return safe;
  }
}
