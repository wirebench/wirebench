import { z } from 'zod';
import { HIGH_HALVES } from './charset-tables.js';

/** The character sets a host's terminal may use (#427); UTF-8 by default. */
export const CHARSETS = ['utf-8', ...(Object.keys(HIGH_HALVES) as Array<keyof typeof HIGH_HALVES>)] as const;
export type Charset = 'utf-8' | keyof typeof HIGH_HALVES;

export const DEFAULT_CHARSET: Charset = 'utf-8';
export const DEFAULT_TERM = 'xterm-256color';

/** A terminfo name: what `TERM` takes, and nothing a pty request could be confused by. */
export const TERM_NAME = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

export function isCharset(value: string): value is Charset {
  return (CHARSETS as readonly string[]).includes(value);
}

export const charsetSchema = z
  .string()
  .refine(isCharset, `must be one of ${CHARSETS.join(', ')}`)
  .transform((c) => c)
  .optional();
export const termSchema = z
  .string()
  .regex(TERM_NAME, 'must be a terminal type name (letters, digits, . + _ -, at most 64)')
  .optional();

/**
 * Turns a session's bytes into UTF-8 and back. The terminal, the logs and everything else downstream speak
 * UTF-8 only; the codec sits between them and the server. For UTF-8 both directions pass bytes through.
 */
export interface TerminalCodec {
  /** Server bytes to UTF-8. A single-byte set holds no state between calls. */
  decode(data: Uint8Array): Uint8Array;
  /** UTF-8 to server bytes; a character the set lacks goes as `?`. A UTF-8 sequence split across calls is joined. */
  encode(data: Uint8Array): Uint8Array;
}

const PASS_THROUGH: TerminalCodec = { decode: (data) => data, encode: (data) => data };
const UNKNOWN = 0x3f; // '?'

export function terminalCodec(charset: Charset = DEFAULT_CHARSET): TerminalCodec {
  if (charset === 'utf-8') return PASS_THROUGH;
  const high = [...HIGH_HALVES[charset]];
  const back = new Map<string, number>();
  high.forEach((ch, i) => {
    if (ch !== '�' && !back.has(ch)) back.set(ch, 0x80 + i);
  });
  const toUtf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder('utf-8');
  return {
    decode(data) {
      if (data.every((b) => b < 0x80)) return data;
      let text = '';
      for (const b of data) text += b < 0x80 ? String.fromCharCode(b) : (high[b - 0x80] as string);
      return toUtf8.encode(text);
    },
    encode(data) {
      const out: number[] = [];
      for (const ch of fromUtf8.decode(data, { stream: true })) {
        const code = ch.codePointAt(0) as number;
        out.push(code < 0x80 ? code : (back.get(ch) ?? UNKNOWN));
      }
      return Uint8Array.from(out);
    },
  };
}
