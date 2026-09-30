import { describe, expect, it } from 'vitest';
import { cutText, keptLength } from '../../../src/ops/cut.js';
import { MAX_STORED_CHARS, storedText } from '../../../src/ops/history-entry.js';

const FACE = '\u{1F600}';

describe('cutText', () => {
  it('keeps text within the size whole, and never ends a cut on the first half of a pair', () => {
    expect(cutText('abc', 3)).toBe('abc');
    expect(cutText('abcd', 3)).toBe('abc');
    expect(cutText(`ab${FACE}`, 3)).toBe('ab');
    expect(cutText(`a${FACE}b`, 3)).toBe(`a${FACE}`);
    expect(keptLength(FACE, 1)).toBe(0);
    expect(keptLength('abc', 0)).toBe(0);
  });
});

describe('storedText', () => {
  it('cuts a long body before a pair it would split, and counts what it left out', () => {
    const body = `${'x'.repeat(MAX_STORED_CHARS - 1)}${FACE}tail`;

    const stored = storedText(body, (text) => text);

    expect(stored).toBe(`${'x'.repeat(MAX_STORED_CHARS - 1)}\n… truncated, 6 more characters`);
  });
});
