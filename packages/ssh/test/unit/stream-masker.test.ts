import { describe, expect, it } from 'vitest';
import { createStreamMasker, SECRET_MASK } from '../../src/index.js';
import type { StreamMasker } from '../../src/index.js';

const enc = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const dec = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

/** Feeds `input` cut at `cuts` (byte offsets), then flushes; returns the output as text. */
function run(masker: StreamMasker, input: string, cuts: readonly number[]): string {
  const bytes = enc(input);
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const cut of [...cuts, bytes.length]) {
    parts.push(masker.push(bytes.subarray(from, cut)));
    from = cut;
  }
  parts.push(masker.flush());
  return dec(Buffer.concat(parts));
}

/** Every byte its own chunk. */
const byteByByte = (input: string): number[] => Array.from({ length: enc(input).length - 1 }, (_, i) => i + 1);

const masker = (...values: string[]): StreamMasker => {
  const m = createStreamMasker();
  m.add(values);
  return m;
};

describe('createStreamMasker', () => {
  it('before add, push returns its input and never holds', () => {
    const m = createStreamMasker();
    const chunk = enc('anything at all');
    expect(m.push(chunk)).toBe(chunk);
    expect(m.holding).toBe(false);
    expect(m.flush().length).toBe(0);
  });
  it('masks a value inside one chunk with U+2022 × 4', () => {
    expect(run(masker('hunter2'), 'pw is hunter2 ok', [])).toBe(`pw is ${SECRET_MASK} ok`);
    expect([...enc(SECRET_MASK)]).toEqual([0xe2, 0x80, 0xa2, 0xe2, 0x80, 0xa2, 0xe2, 0x80, 0xa2, 0xe2, 0x80, 0xa2]);
  });
  it('masks every occurrence', () => {
    expect(run(masker('hunter2'), 'hunter2 x hunter2', [])).toBe(`${SECRET_MASK} x ${SECRET_MASK}`);
  });
  it('masks a value split across two and three chunks', () => {
    expect(run(masker('hunter2'), 'pw hunter2 ok', [6])).toBe(`pw ${SECRET_MASK} ok`);
    expect(run(masker('hunter2'), 'pw hunter2 ok', [4, 8])).toBe(`pw ${SECRET_MASK} ok`);
  });
  it('byte by byte, no prefix of the value is ever emitted', () => {
    const m = masker('hunter2');
    let out = '';
    for (const byte of enc('echo hunter2; done')) {
      out += dec(m.push(Uint8Array.of(byte)));
      expect(out).not.toContain('hu');
    }
    out += dec(m.flush());
    expect(out).toBe(`echo ${SECRET_MASK}; done`);
  });
  it('a multi-byte value split inside a character is masked', () => {
    const input = 'login pässwört\r\n';
    const insideA = enc('login pä').length - 1; // between the two bytes of ä
    expect(run(masker('pässwört'), input, [insideA])).toBe(`login ${SECRET_MASK}\r\n`);
    expect(run(masker('pässwört'), input, byteByByte(input))).toBe(`login ${SECRET_MASK}\r\n`);
  });
  it('where one value is a prefix of another, the longer match is masked whole', () => {
    expect(run(masker('abc', 'abcdef'), 'x abcdef y', [])).toBe(`x ${SECRET_MASK} y`);
    expect(run(masker('abc', 'abcdef'), 'x abcdef y', byteByByte('x abcdef y'))).toBe(`x ${SECRET_MASK} y`);
    expect(run(masker('abc', 'abcdef'), 'x abcde y', byteByByte('x abcde y'))).toBe(`x ${SECRET_MASK}de y`);
  });
  it('overlapping occurrences merge into one mask, in one chunk and cut', () => {
    expect(run(masker('aXa'), '[aXaXa]', [])).toBe(`[${SECRET_MASK}]`);
    expect(run(masker('aXa'), '[aXaXa]', byteByByte('[aXaXa]'))).toBe(`[${SECRET_MASK}]`);
    expect(run(masker('aXa'), 'aXaXa', [3])).toBe(SECRET_MASK);
  });
  it('a held tail is released unmasked and in order when the next chunk diverges', () => {
    const m = masker('hunter2');
    expect(dec(m.push(enc('$ hun')))).toBe('$ ');
    expect(m.holding).toBe(true);
    expect(dec(m.push(enc('gry\n')))).toBe('hungry\n');
    expect(m.holding).toBe(false);
  });
  it('flush releases a held prompt as it is', () => {
    const m = masker('hunter2');
    expect(dec(m.push(enc('user@host:~$ h')))).toBe('user@host:~$ ');
    expect(m.holding).toBe(true);
    expect(dec(m.flush())).toBe('h');
    expect(m.holding).toBe(false);
    expect(m.flush().length).toBe(0);
  });
  it('flush masks a held tail that is a whole shorter value', () => {
    const m = masker('abc', 'abcdef');
    expect(dec(m.push(enc('x abc')))).toBe('x ');
    expect(dec(m.flush())).toBe(SECRET_MASK);
  });
  it('holds only a tail that can start a value', () => {
    const m = masker('hunter2');
    m.push(enc('nothing like it'));
    expect(m.holding).toBe(false);
    m.push(enc('...hunt'));
    expect(m.holding).toBe(true);
  });
  it('touching occurrences are two masks, however the stream is cut', () => {
    expect(run(masker('ab', 'cd'), '[abcd]', [])).toBe(`[${SECRET_MASK}${SECRET_MASK}]`);
    expect(run(masker('ab', 'cd'), '[abcd]', [3])).toBe(`[${SECRET_MASK}${SECRET_MASK}]`);
  });
  it('ignores empty values and keeps duplicates once', () => {
    expect(run(masker('', 'hunter2', 'hunter2'), 'a hunter2 b', [])).toBe(`a ${SECRET_MASK} b`);
    const none = masker('');
    const chunk = enc('plain');
    expect(none.push(chunk)).toBe(chunk);
  });
  it('a value added later masks from then on', () => {
    const m = createStreamMasker();
    expect(dec(m.push(enc('hunter2 ')))).toBe('hunter2 ');
    m.add(['hunter2']);
    expect(dec(m.push(enc('hunter2')))).toBe(SECRET_MASK);
    expect(dec(m.flush())).toBe('');
    expect(dec(m.push(enc(' hunter2 ')))).toBe(` ${SECRET_MASK} `);
  });
  it('any chunking gives the same output as masking the whole text', () => {
    const values = ['s3cr3t', 'pässwört', 'tok-tok'];
    const input = 'a s3cr3t b pässwört c tok-tok-tok d s3cr3s3cr3t e pässw f\r\n$ ';
    const whole = run(masker(...values), input, []);
    expect(whole).toBe(`a ${SECRET_MASK} b ${SECRET_MASK} c ${SECRET_MASK} d s3cr3${SECRET_MASK} e pässw f\r\n$ `);
    const length = enc(input).length;
    let seed = 7;
    const random = (): number => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    for (let round = 0; round < 200; round += 1) {
      const count = 1 + Math.floor(random() * 12);
      const cuts = [...new Set(Array.from({ length: count }, () => 1 + Math.floor(random() * (length - 1))))];
      expect(
        run(
          masker(...values),
          input,
          cuts.sort((a, b) => a - b),
        ),
      ).toBe(whole);
    }
    expect(run(masker(...values), input, byteByByte(input))).toBe(whole);
  });
  it('matches an independent whole-text masker on random overlapping input, cut at random', () => {
    /** Every occurrence of every value found on the whole text, overlapping ones merged. */
    const oracle = (text: string, values: readonly string[]): string => {
      const found: [number, number][] = [];
      for (const v of values)
        for (let i = text.indexOf(v); i !== -1; i = text.indexOf(v, i + 1)) found.push([i, i + v.length]);
      found.sort((a, b) => a[0] - b[0]);
      let out = '';
      let at = 0;
      let open: [number, number] | undefined;
      for (const [start, end] of [...found, [Infinity, Infinity] as [number, number]]) {
        if (open && start < open[1]) {
          open[1] = Math.max(open[1], end);
          continue;
        }
        if (open) {
          out += text.slice(at, open[0]) + SECRET_MASK;
          at = open[1];
        }
        open = [start, end];
      }
      return out + text.slice(at);
    };
    let seed = 11;
    const random = (n: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const values = ['aba', 'bab', 'aab', 'ä'];
    const alphabet = ['a', 'b', 'ä', ' '];
    for (let round = 0; round < 500; round += 1) {
      const input = Array.from({ length: 1 + random(30) }, () => alphabet[random(alphabet.length)]).join('');
      const length = enc(input).length;
      const cuts = [...new Set(Array.from({ length: random(8) }, () => 1 + random(Math.max(1, length - 1))))]
        .filter((c) => c < length)
        .sort((a, b) => a - b);
      expect(run(masker(...values), input, cuts), `${JSON.stringify(input)} cut at ${cuts.join(',')}`).toBe(
        oracle(input, values),
      );
    }
  });
});
