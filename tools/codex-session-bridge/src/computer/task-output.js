import { StringDecoder } from 'node:string_decoder';
import { BridgeError, redact } from '../errors.js';

export const OUTPUT_BUDGETS = Object.freeze({ output_bytes: 1048576, events: 4096, line_bytes: 65536, page_bytes: 524288 });

// Publish only immutable, fully decoded/redacted lines. Never redact OS chunks.
export class TaskOutput {
  constructor(onLimit, onPublish = () => {}) {
    this.onLimit = onLimit;
    this.onPublish = onPublish;
    this.events = [];
    this.bytes = 0;
    this.redacted = false;
    this.interrupted = false;
    this.limited = false;
    this.streams = Object.fromEntries(['stdout', 'stderr'].map(name => [name,
      { decoder: new StringDecoder('utf8'), pending: '', bytes: 0, truncated: false, ended: false, discardLine: false }]));
  }

  capture(name, chunk) {
    const stream = this.streams[name];
    if (this.limited || stream.ended) { stream.truncated = true; return; }
    const take = Math.min(chunk.length, OUTPUT_BUDGETS.output_bytes - this.bytes);
    this.bytes += take; stream.bytes += take;
    const decoded = stream.decoder.write(chunk.subarray(0, take));
    let begin = 0;
    for (let end = decoded.indexOf('\n'); end !== -1; end = decoded.indexOf('\n', begin)) {
      if (stream.discardLine) stream.discardLine = false;
      else {
        stream.pending += decoded.slice(begin, end + 1);
        if (!this.publish(name)) return;
      }
      begin = end + 1;
    }
    if (!stream.discardLine) stream.pending += decoded.slice(begin);
    const partialBytes = stream.decoder.lastNeed ? stream.decoder.lastTotal - stream.decoder.lastNeed : 0;
    if (Buffer.byteLength(stream.pending) + partialBytes > OUTPUT_BUDGETS.line_bytes || take < chunk.length) this.limit(name);
  }

  publish(name) {
    const stream = this.streams[name];
    if (Buffer.byteLength(stream.pending) > OUTPUT_BUDGETS.line_bytes || this.events.length >= OUTPUT_BUDGETS.events) { this.limit(name); return false; }
    const text = redact(stream.pending);
    this.redacted ||= text !== stream.pending;
    this.events.push({ seq: this.events.length, stream: name, text });
    stream.pending = '';
    this.onPublish(this.events.at(-1));
    return true;
  }

  limit(name) {
    this.streams[name].truncated = true;
    this.limited = true;
    this.interrupt();
    this.onLimit();
  }

  interrupt() {
    this.interrupted = true;
    // A cut token must not become a shorter unredacted token at EOF.
    for (const stream of Object.values(this.streams)) {
      if (stream.pending || stream.decoder.lastNeed) { stream.truncated = true; stream.discardLine = true; }
      stream.pending = '';
    }
  }

  end(name) {
    const stream = this.streams[name];
    if (stream.ended) return;
    stream.ended = true;
    if (this.interrupted || stream.decoder.lastNeed) {
      if (stream.pending || stream.decoder.lastNeed) stream.truncated = true;
      stream.pending = '';
    } else {
      stream.pending += stream.decoder.end();
      if (stream.pending) this.publish(name);
    }
  }

  metadata() {
    const { stdout, stderr } = this.streams;
    return { limit_bytes: OUTPUT_BUDGETS.output_bytes, stdout_bytes: stdout.bytes, stderr_bytes: stderr.bytes,
      pipes_closed: stdout.ended && stderr.ended,
      stdout_truncated: stdout.truncated, stderr_truncated: stderr.truncated,
      incomplete: this.interrupted || !stdout.ended || !stderr.ended || stdout.truncated || stderr.truncated,
      redacted: this.redacted };
  }

  page(task_id, status, cursor, limit) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.events.length || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new BridgeError('INVALID_CURSOR', 'Invalid output cursor or limit.');
    const result = { task_id, status, output: this.metadata(), events: [], next_cursor: cursor, has_more: cursor < this.events.length };
    for (const event of this.events.slice(cursor, cursor + limit)) {
      result.events.push(event); result.next_cursor++;
      result.has_more = result.next_cursor < this.events.length;
      if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_BUDGETS.page_bytes) {
        result.events.pop(); result.next_cursor--; result.has_more = true; break;
      }
    }
    return result;
  }
}
