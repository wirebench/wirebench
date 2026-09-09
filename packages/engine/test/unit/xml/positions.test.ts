import { describe, expect, it } from 'vitest';
import { LineIndex } from '../../../src/xml/positions.js';

describe('LineIndex', () => {
  it('round-trips offsets and positions on LF text', () => {
    const text = 'abc\ndef\nghi';
    const idx = new LineIndex(text);

    expect(idx.offsetToPosition(0)).toEqual({ line: 1, column: 1 });
    expect(idx.offsetToPosition(3)).toEqual({ line: 1, column: 4 });
    expect(idx.offsetToPosition(4)).toEqual({ line: 2, column: 1 });
    expect(idx.offsetToPosition(text.length - 1)).toEqual({ line: 3, column: 3 });

    for (let offset = 0; offset <= text.length; offset += 1) {
      const pos = idx.offsetToPosition(offset);
      expect(idx.positionToOffset(pos.line, pos.column)).toBe(offset);
    }
  });

  it('round-trips offsets and positions on CRLF text', () => {
    const text = 'abc\r\ndef\r\nghi';
    const idx = new LineIndex(text);

    expect(idx.offsetToPosition(0)).toEqual({ line: 1, column: 1 });
    // index 5 is 'd', the first char of line 2 (after \r\n at 3,4)
    expect(idx.offsetToPosition(5)).toEqual({ line: 2, column: 1 });
    expect(idx.offsetToPosition(text.length - 1)).toEqual({ line: 3, column: 3 });

    for (let offset = 0; offset <= text.length; offset += 1) {
      const pos = idx.offsetToPosition(offset);
      expect(idx.positionToOffset(pos.line, pos.column)).toBe(offset);
    }
  });

  it('handles a single-line document', () => {
    const text = 'hello world';
    const idx = new LineIndex(text);
    expect(idx.offsetToPosition(0)).toEqual({ line: 1, column: 1 });
    expect(idx.offsetToPosition(text.length)).toEqual({ line: 1, column: text.length + 1 });
    expect(idx.positionToOffset(1, 1)).toBe(0);
  });

  it('treats a bare CR (old Mac line ending) as its own line terminator', () => {
    const text = 'abc\rdef';
    const idx = new LineIndex(text);
    expect(idx.offsetToPosition(4)).toEqual({ line: 2, column: 1 });
    expect(idx.positionToOffset(2, 1)).toBe(4);
  });

  it('clamps out-of-range offsets', () => {
    const text = 'abc\ndef';
    const idx = new LineIndex(text);
    expect(idx.offsetToPosition(-5)).toEqual({ line: 1, column: 1 });
    expect(idx.offsetToPosition(1000)).toEqual(idx.offsetToPosition(text.length));
  });

  it('clamps out-of-range line numbers', () => {
    const text = 'abc\ndef';
    const idx = new LineIndex(text);
    expect(idx.positionToOffset(-5, 1)).toBe(0);
    expect(idx.positionToOffset(1000, 1)).toBe(idx.positionToOffset(2, 1));
  });
});
