import { describe, expect, it } from 'vitest';
import { createTextLog, FULL_SCREEN_NOTE, TEXT_LOG_MAX_LINE } from '../../src/index.js';

const enc = (text: string): Uint8Array => Buffer.from(text, 'utf8');

/** Feeds `input` cut at `cuts` (byte offsets), then flushes. */
function run(input: string | Uint8Array, cuts: readonly number[] = []): string {
  const bytes = typeof input === 'string' ? enc(input) : input;
  const log = createTextLog();
  let out = '';
  let from = 0;
  for (const cut of [...cuts, bytes.length]) {
    out += log.push(bytes.subarray(from, cut));
    from = cut;
  }
  return out + log.flush();
}

/** Every way of cutting `input` in two. */
function everyCut(input: string, expected: string): void {
  const length = enc(input).length;
  for (let cut = 0; cut <= length; cut += 1) expect(run(input, [cut]), `cut at ${cut}`).toBe(expected);
}

describe('createTextLog', () => {
  it('passes plain lines through and turns CRLF into LF', () => {
    expect(run('hello\r\nworld\r\n')).toBe('hello\nworld\n');
  });

  it('strips colour and cursor sequences, wherever a chunk is cut', () => {
    everyCut('\x1b[1;32mok\x1b[0m done\r\n', 'ok done\n');
  });

  it('strips a title (OSC) ending in BEL or in ST', () => {
    expect(run('\x1b]0;user@box: ~\x07$ ls\r\n')).toBe('$ ls\n');
    everyCut('\x1b]2;title\x1b\\$ pwd\r\n', '$ pwd\n');
  });

  it('strips charset, keypad and save-cursor escapes, and DCS strings', () => {
    expect(run('\x1b(B\x1b=\x1b7a\x1b8b\x1bP1$r0m\x1b\\c\n')).toBe('abc\n');
  });

  it('keeps the last state of a line a carriage return rewrote (a progress bar)', () => {
    expect(run('  0%\r 50%\r100%\r\ndone\r\n')).toBe('100%\ndone\n');
  });

  it('applies backspace and erase-in-line as the screen does', () => {
    expect(run('abc\b\bX\r\n')).toBe('aXc\n');
    expect(run('hello world\r\x1b[Kbye\r\n')).toBe('bye\n');
    expect(run('hello world\r\x1b[2Kbye\r\n')).toBe('bye\n');
  });

  it('keeps tabs and drops other control characters', () => {
    expect(run('a\tb\x07c\x00\r\n')).toBe('a\tbc\n');
  });

  it('decodes a UTF-8 character cut between chunks', () => {
    everyCut('héllo ✓\r\n', 'héllo ✓\n');
  });

  it('flushes a last line that has no newline', () => {
    expect(run('$ ')).toBe('$ ');
  });

  it('leaves out what a full-screen program draws, with one note in its place', () => {
    expect(run('$ top\r\n\x1b[?1049h\x1b[Hload 1.0\r\nmore\x1b[?1049l$ exit\r\n')).toBe(
      `$ top\n${FULL_SCREEN_NOTE}\n$ exit\n`,
    );
  });

  it('cuts a line longer than the limit rather than holding it in memory', () => {
    const log = createTextLog();
    const out = log.push(enc('x'.repeat(TEXT_LOG_MAX_LINE + 10)));
    expect(out).toBe(`${'x'.repeat(TEXT_LOG_MAX_LINE)}\n`);
    expect(log.flush()).toBe('x'.repeat(10));
  });
});
