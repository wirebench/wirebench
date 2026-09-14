import { describe, expect, it } from 'vitest';
import {
  base64ByteLength,
  decodeBase64Text,
  formatBytes,
  formatClockTime,
  formatDuration,
} from '../../src/renderer/lib/format-size.js';

describe('formatBytes', () => {
  it('keeps sub-kilobyte values whole', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(842)).toBe('842 B');
  });

  it('switches unit at 1024 and keeps one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1229)).toBe('1.2 KB');
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
  });

  it('refuses to invent a size for a nonsense input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('base64ByteLength', () => {
  it('accounts for padding', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength(btoa('a'))).toBe(1);
    expect(base64ByteLength(btoa('ab'))).toBe(2);
    expect(base64ByteLength(btoa('abc'))).toBe(3);
    expect(base64ByteLength(btoa('abcd'))).toBe(4);
  });
});

describe('decodeBase64Text', () => {
  it('round-trips UTF-8', () => {
    expect(decodeBase64Text(btoa('hello'))).toBe('hello');
  });

  it('returns undefined for a payload that is not base64', () => {
    expect(decodeBase64Text('not base64!!')).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('rounds away the float noise performance.now() arithmetic leaves behind', () => {
    expect(formatDuration(15.645407999999861)).toBe('16 ms');
    expect(formatDuration(2.365666999999803)).toBe('2.4 ms');
    expect(formatDuration(13.657760699999846)).toBe('14 ms');
  });

  it('keeps one decimal below 10 ms, where rounding would erase the number', () => {
    expect(formatDuration(0.42)).toBe('0.4 ms');
    expect(formatDuration(9.94)).toBe('9.9 ms');
    expect(formatDuration(0)).toBe('0.0 ms');
  });

  it('switches to whole milliseconds at 10 and stays there', () => {
    expect(formatDuration(10)).toBe('10 ms');
    expect(formatDuration(1234.5)).toBe('1235 ms');
  });
});

describe('formatClockTime', () => {
  it('renders HH:MM:SS in local time', () => {
    const iso = new Date(2026, 8, 10, 8, 30, 5).toISOString();
    expect(formatClockTime(iso)).toBe('08:30:05');
  });

  it('does not guess at an unparseable timestamp', () => {
    expect(formatClockTime('nope')).toBe('—');
  });
});
