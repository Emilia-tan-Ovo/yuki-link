import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCredential } from '../desktop/electron/credential.mjs';

test('keeps a new key with periods intact and trims only surrounding whitespace', () => {
  assert.equal(normalizeCredential(' \r\nsk-live.part_2.more\t '), 'sk-live.part_2.more');
});

test('accepts a safe nonempty key without the old sk- prefix', () => {
  assert.equal(normalizeCredential('new_format.key'), 'new_format.key');
});

test('rejects embedded whitespace and control characters', () => {
  for (const raw of ['part one', 'part\r\none', 'part\x00one', 'part\x7fone', 'part\u00a0one']) {
    assert.throws(() => normalizeCredential(raw), /凭据文件格式不正确/);
  }
});

test('rejects empty and oversized credentials', () => {
  for (const raw of ['', ' \r\n\t ', 'a'.repeat(4097)]) {
    assert.throws(() => normalizeCredential(raw), /凭据文件格式不正确/);
  }
});
