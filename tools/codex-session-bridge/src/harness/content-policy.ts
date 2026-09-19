import { redact } from '../errors.js';
import type { ComputerCall } from './model.ts';

// 只处理持久副本；来源限制保持原状，不增加 Harness 内容预算。
export function protectedCopy<T>(value: T): { value: T; redacted: boolean } {
  let redacted = false;
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item;
    const safe = redact(item);
    redacted ||= safe !== item;
    return safe;
  });
  if (serialized === undefined) throw new Error('CONTENT_NOT_SERIALIZABLE');
  return { value: JSON.parse(serialized) as T, redacted };
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
export function sourceIntegrity(stage: ComputerCall['stage'], result: unknown, error: unknown): ComputerCall['integrity'] {
  const details = object(object(error).details);
  const source = object(result ?? details.result);
  const output = object(source.output);
  const flag = (key: string) => typeof output[key] === 'boolean' ? output[key] as boolean : 'unknown' as const;
  const stdout = flag('stdout_truncated'), stderr = flag('stderr_truncated');
  const field = (key: string) => stage === 'started' ? 'not-yet-observed' as const
    : Object.hasOwn(source, key) ? 'observed' as const : 'source-not-provided' as const;
  return { policy: 'bridge-redact-v1', redacted: false, source_redaction: flag('redacted'),
    truncated: stdout === true || stderr === true ? true : stdout === false && stderr === false ? false : 'unknown',
    incomplete: flag('incomplete'), stdout: field('stdout'), stderr: field('stderr'), exit_code: field('exit_code') };
}
