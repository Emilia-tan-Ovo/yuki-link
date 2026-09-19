import type { TaskIdentity, TaskLine, TaskNotice, TaskSnapshot } from './task-model.ts';

// Only this adapter knows the JS source projection. No task execution or script access.
export interface OwnedTaskReader {
  epoch: string;
  identities(): TaskIdentity[];
  subscribe(observer: (identity: TaskIdentity, event: TaskNotice) => void): () => unknown;
  observation(id: string): { snapshot: TaskSnapshot; lifecycle_next: number };
  output(input: { task_id: string; cursor: number; limit: number }): {
    events: TaskLine[]; next_cursor: number; has_more: boolean;
  };
}
export class TaskSource {
  reader: OwnedTaskReader;
  constructor(reader: OwnedTaskReader) { this.reader = reader; }
  epoch() { return this.reader.epoch; }
  identities() { return this.reader.identities(); }
  subscribe(observer: (identity: TaskIdentity, event: TaskNotice) => void) { return this.reader.subscribe(observer); }
  observation(id: string) { return this.reader.observation(id); }
  output(id: string, cursor: number) { return this.reader.output({ task_id: id, cursor, limit: 100 }); }
}
