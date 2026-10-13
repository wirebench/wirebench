/**
 * Turns a session's output into the plain text a session log keeps: escape sequences stripped, a line a
 * carriage return or backspace rewrote kept as it last looked, and what a full-screen program draws left
 * out. Output arrives in chunks of any size, cut anywhere (inside a UTF-8 character or an escape
 * sequence included), so the state carries over from one chunk to the next.
 */
export interface TextLog {
  /** The text of the lines `chunk` finished (each ending in `\n`); the line still open is held. */
  push(chunk: Uint8Array): string;
  /** The line still open, as it looks now (the session ended). */
  flush(): string;
}

/** Characters one line may hold before it is written out cut, so a stream with no newline stays bounded. */
export const TEXT_LOG_MAX_LINE = 16 * 1024;

/** What stands in a log for everything a full-screen program (an editor, a pager, `top`) drew. */
export const FULL_SCREEN_NOTE = '[full-screen output not logged]';

type Mode =
  | 'text'
  /** After ESC. */
  | 'escape'
  /** After ESC and an intermediate byte (`ESC ( B`). */
  | 'escape-intermediate'
  /** Inside `CSI … final`. */
  | 'csi'
  /** Inside an OSC, DCS, SOS, PM or APC string, up to BEL or ST. */
  | 'string'
  /** After an ESC inside a string: `\` ends it. */
  | 'string-escape';

/** The alternate screen a full-screen program draws on: `CSI ? 1049|1047|47 h|l`. */
const ALT_SCREEN = /^\?(?:1049|1047|47)$/;

const isIntermediate = (ch: string): boolean => ch >= ' ' && ch <= '/';

export function createTextLog(): TextLog {
  const decoder = new TextDecoder('utf-8');
  let mode: Mode = 'text';
  let csi = '';
  let line: string[] = [];
  let cursor = 0;
  let fullScreen = false;

  function endLine(out: string[]): void {
    out.push(`${line.join('')}\n`);
    line = [];
    cursor = 0;
  }

  function put(ch: string, out: string[]): void {
    if (cursor >= TEXT_LOG_MAX_LINE) endLine(out);
    line[cursor] = ch;
    cursor += 1;
  }

  function finishCsi(final: string, out: string[]): void {
    const params = csi;
    csi = '';
    if ((final === 'h' || final === 'l') && ALT_SCREEN.test(params)) {
      const entering = final === 'h';
      if (entering && !fullScreen) {
        // The note stands on a line of its own; whatever was on the open line stays above it.
        if (line.length > 0) endLine(out);
        out.push(`${FULL_SCREEN_NOTE}\n`);
      }
      fullScreen = entering;
      return;
    }
    if (fullScreen || final !== 'K') return;
    // Erase in line: 0 (or none) from the cursor on, 1 up to the cursor, 2 the whole line.
    if (params === '' || params === '0') line.length = Math.min(line.length, cursor);
    else if (params === '1') for (let i = 0; i < Math.min(cursor + 1, line.length); i += 1) line[i] = ' ';
    else if (params === '2') line = Array.from({ length: cursor }, () => ' ');
  }

  function escape(ch: string): void {
    if (ch === '[') {
      mode = 'csi';
      csi = '';
    } else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') mode = 'string';
    else mode = isIntermediate(ch) ? 'escape-intermediate' : 'text';
  }

  function control(ch: string, out: string[]): void {
    if (ch === '\x1b') mode = 'escape';
    else if (ch === '\x9b') {
      mode = 'csi';
      csi = '';
    } else if (ch === '\x9d' || ch === '\x90') mode = 'string';
    else if (fullScreen) return;
    else if (ch === '\n') endLine(out);
    else if (ch === '\r') cursor = 0;
    else if (ch === '\b') cursor = Math.max(0, cursor - 1);
    else if (ch === '\t') put(ch, out);
  }

  function feed(text: string, out: string[]): void {
    for (const ch of text) {
      if (mode === 'escape') escape(ch);
      else if (mode === 'escape-intermediate') {
        if (!isIntermediate(ch)) mode = 'text';
      } else if (mode === 'csi') {
        if (ch >= '@' && ch <= '~') {
          mode = 'text';
          finishCsi(ch, out);
        } else csi += ch;
      } else if (mode === 'string') {
        if (ch === '\x07' || ch === '\x9c') mode = 'text';
        else if (ch === '\x1b') mode = 'string-escape';
      } else if (mode === 'string-escape') mode = ch === '\\' ? 'text' : 'string';
      else if (ch < ' ' || (ch >= '\x7f' && ch <= '\x9f')) control(ch, out);
      else if (!fullScreen) put(ch, out);
    }
  }

  return {
    push(chunk) {
      const out: string[] = [];
      feed(decoder.decode(chunk, { stream: true }), out);
      return out.join('');
    },
    flush() {
      const out: string[] = [];
      feed(decoder.decode(), out);
      const rest = line.join('');
      line = [];
      cursor = 0;
      return out.join('') + rest;
    },
  };
}
