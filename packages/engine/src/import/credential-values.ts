/**
 * The credential rule every request importer applies to what it writes into a project (spec §3.4,
 * §11): a literal value under a credential-looking name is blanked, or dropped from the headers,
 * while a value made only of references stays. Shared by the `.http` and OpenCollection mappers.
 * Pure, and free of Node.
 */

import type { KeyValueEntry } from '../http/entries.js';
import { entry } from '../http/entries.js';
import type { AuthConfig } from '../project/model.js';
import { isCredentialName } from './credentials.js';
import type { ReportBuilder } from './report.js';
import { REFERENCE, referencesOnly, stripUserinfo } from './values.js';

const AUTH_REFERENCES_ONLY = new RegExp(String.raw`^\s*(?:Bearer|Basic)\s+(?:${REFERENCE}\s*)+$`, 'i');
/** A JSON number or boolean a key may be blanked for, matched where it starts; strings are scanned by hand. */
const JSON_BARE_SCALAR = /-?\d[\w.+-]*|true|false/y;

/** The end (past the closing quote) of the JSON string opening at `start`, or -1 when it is not closed on its line. */
function jsonStringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') return i + 1;
    if (char === '\n') return -1;
    if (char === '\\') {
      if (text[i + 1] === '\n') return -1;
      i += 1;
    }
  }
  return -1;
}

function isJsonSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

/** `text` with each `"key": value` whose key looks like a credential and whose value is a literal blanked to `""`. One pass. */
function blankJsonPairs(text: string, blanked: Set<string>): string {
  let out = '';
  let copied = 0;
  // Hand-scanned rather than matched: each character is looked at a bounded number of times, so
  // no input (an unterminated string full of escapes, a long whitespace run) can make it slow.
  for (let open = text.indexOf('"'); open !== -1;) {
    const keyEnd = jsonStringEnd(text, open);
    if (keyEnd === -1) {
      // Not closed on its line: what follows on that line is inside the string.
      const lineEnd = text.indexOf('\n', open);
      if (lineEnd === -1) break;
      open = text.indexOf('"', lineEnd);
      continue;
    }
    const key = text.slice(open + 1, keyEnd - 1);
    open = text.indexOf('"', keyEnd);
    let i = keyEnd;
    while (isJsonSpace(text[i])) i += 1;
    if (text[i] !== ':') continue;
    i += 1;
    while (isJsonSpace(text[i])) i += 1;
    let value: string;
    if (text[i] === '"') {
      const close = jsonStringEnd(text, i);
      if (close === -1) continue;
      value = text.slice(i, close);
    } else {
      JSON_BARE_SCALAR.lastIndex = i;
      const scalar = JSON_BARE_SCALAR.exec(text);
      if (scalar === null) continue;
      value = scalar[0];
    }
    const bare = value.startsWith('"') ? value.slice(1, -1) : value;
    const end = i + value.length;
    open = text.indexOf('"', end);
    if (blankIfLiteral(key, bare, blanked) === bare) continue;
    out += `${text.slice(copied, i)}""`;
    copied = end;
  }
  return out + text.slice(copied);
}

/** `value` unless it is a literal credential under a credential-looking `name`; then `''`, with `name` added to `blanked`. */
export function blankIfLiteral(name: string, value: string, blanked: Set<string>): string {
  if (value === '' || !isCredentialName(name) || referencesOnly(value)) return value;
  blanked.add(name);
  return '';
}

/**
 * `rel` resolved against `dir`, without `node:path`: either separator is understood, and the
 * result uses the one `dir` is written with.
 */
export function resolvePath(dir: string, rel: string): string {
  if (/^(?:[A-Za-z]:)?[\\/]/.test(rel)) return rel;
  const sep = /^[A-Za-z]:/.test(dir) || (dir.includes('\\') && !dir.includes('/')) ? '\\' : '/';
  const parts = dir.split(/[\\/]/);
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  for (const part of rel.split(/[\\/]/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(part);
    }
  }
  const joined = parts.join(sep);
  return joined === '' ? sep : joined;
}

/** The user name in a Basic credential: `user password`, `user:password`, or base64 `user:password`. */
function basicUsername(credential: string): string | undefined {
  const tokens = credential.trim().split(/\s+/);
  if (tokens.length >= 2) return tokens[0];
  const token = tokens[0] ?? '';
  let decoded = token;
  if (!token.includes(':')) {
    try {
      decoded = atob(token);
    } catch {
      return undefined;
    }
    if (/[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
  }
  const colon = decoded.indexOf(':');
  return colon > 0 ? decoded.slice(0, colon) : undefined;
}

/**
 * The request's auth and the headers it keeps. A references-only `Authorization` stays a header
 * under inherited auth; a literal one becomes bearer or basic (user name only), or `none` for any
 * other scheme, and is dropped. Any other credential-looking header with a literal value is
 * dropped, its name added to `blanked`.
 */
export function headersAndAuth(
  headers: readonly { readonly name: string; readonly value: string; readonly enabled?: boolean }[],
  label: string,
  report: ReportBuilder,
  blanked: Set<string>,
): { headers: KeyValueEntry[]; auth: AuthConfig } {
  let auth: AuthConfig = { type: 'inherit' };
  const kept: KeyValueEntry[] = [];
  for (const header of headers) {
    const { name, value } = header;
    const options = header.enabled === false ? { enabled: false } : undefined;
    if (name.toLowerCase() === 'authorization') {
      if (AUTH_REFERENCES_ONLY.test(value) || referencesOnly(value) || value.trim() === '') {
        kept.push(entry(name, value, options));
        continue;
      }
      // A disabled header is not how the request authenticates, so it leaves the auth alone.
      if (header.enabled === false) {
        report.warn(`${label}: the Authorization credential was not imported; set it on the request or API.`);
        continue;
      }
      const trimmed = value.trim();
      const space = trimmed.search(/\s/);
      const scheme = space === -1 ? trimmed : trimmed.slice(0, space);
      const credential = space === -1 ? '' : trimmed.slice(space).trim();
      const lower = scheme.toLowerCase();
      if (lower === 'bearer' || lower === 'basic') {
        report.warn(`${label}: the Authorization credential was not imported; set it on the request or API.`);
        if (lower === 'bearer') {
          auth = { type: 'bearer' };
        } else {
          const username = basicUsername(credential);
          auth = { type: 'basic', ...(username !== undefined ? { username } : {}) };
        }
      } else {
        // Name the scheme only when the value is clearly `<scheme> <credentials>`; a scheme-less
        // value would otherwise put the credential itself into the report.
        if (/^[A-Za-z][\w-]*$/.test(scheme) && credential !== '') {
          report.warn(`${label}: ${scheme} authentication is not supported and was imported as none.`);
        } else {
          report.warn(`${label}: the Authorization header has an unrecognised form and was imported as none.`);
        }
        auth = { type: 'none' };
      }
      continue;
    }
    if (blankIfLiteral(name, value, blanked) !== value) continue;
    kept.push(entry(name, value, options));
  }
  return { headers: kept, auth };
}

/** A copy of a parsed JSON value with every literal credential-keyed value blanked, each key added to `found`. */
function blankJson(value: unknown, found: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => blankJson(item, found));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        if (!isCredentialName(key)) return [key, blankJson(inner, found)];
        if (typeof inner === 'string' && (inner === '' || referencesOnly(inner))) return [key, inner];
        found.add(key);
        return [key, ''];
      }),
    );
  }
  return value;
}

/**
 * A JSON body with its literal credential values blanked. Every `"key": value` pair is blanked in
 * place first, which keeps the formatting and catches a repeated key; when the text then parses,
 * a credential key holding an object or array is blanked too, and only that re-serialises.
 */
export function blankJsonText(text: string, blanked: Set<string>): string {
  let parseable = true;
  try {
    JSON.parse(text);
  } catch {
    parseable = false;
  }
  const inPlace = blankJsonPairs(text, blanked);
  if (!parseable) return inPlace;
  const found = new Set<string>();
  const out = blankJson(JSON.parse(inPlace), found);
  if (found.size === 0) return inPlace;
  for (const key of found) blanked.add(key);
  return JSON.stringify(out, null, /\n( +)\S/.exec(text)?.[1]?.length);
}

/** A form-encoded text with literal credential values blanked in place, keeping the rest as written. */
export function blankFormText(text: string, blanked: Set<string>): string {
  return text
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals === -1) return pair;
      const name = pair.slice(0, equals);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        // a malformed escape: test the name as written
      }
      const value = pair.slice(equals + 1);
      return blankIfLiteral(decoded, value, blanked) === value ? pair : `${name}=`;
    })
    .join('&');
}

/**
 * A URL with its literal user info cut and the literal credential values of its query blanked,
 * each name added to `blanked`. Every `${…}` is shielded while the query and the fragment are
 * found, so a `#` inside a reference is not read as the fragment.
 */
export function blankUrlCredentials(url: string, blanked: Set<string>): { url: string; stripped: boolean } {
  const { url: withoutUser, stripped } = stripUserinfo(url);
  const refs: string[] = [];
  const shielded = withoutUser.replace(/\$\{[^{}]*\}/g, (m) => {
    refs.push(m);
    return `\u0000${refs.length - 1}\u0000`;
  });
  const restore = (text: string): string =>
    text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => refs[Number(i)] ?? '');
  const hash = shielded.indexOf('#');
  const end = hash === -1 ? shielded.length : hash;
  const mark = shielded.indexOf('?');
  if (mark === -1 || mark > end) return { url: withoutUser, stripped };
  const search = blankFormText(restore(shielded.slice(mark + 1, end)), blanked);
  return { url: restore(shielded.slice(0, mark + 1)) + search + restore(shielded.slice(end)), stripped };
}

/**
 * A multipart body with the value of each literal credential text part blanked: a part whose
 * `name` looks like a credential and that has no `filename`. Everything else stays as written.
 */
export function blankMultipartText(text: string, contentType: string, blanked: Set<string>): string {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1]?.trim();
  if (boundary === undefined || boundary === '') return text;
  const delimiter = `--${boundary}`;
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    out.push(line);
    i += 1;
    if (line.trim() !== delimiter) continue;
    let name: string | undefined;
    let file = false;
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      const header = lines[i] ?? '';
      if (/^content-disposition:/i.test(header)) {
        name = /[;\s]name="([^"]*)"/i.exec(header)?.[1];
        file = /[;\s]filename\*?=/i.test(header);
      }
      out.push(header);
      i += 1;
    }
    if (i < lines.length) {
      out.push(lines[i] ?? '');
      i += 1;
    }
    const value: string[] = [];
    while (i < lines.length && !(lines[i] ?? '').trim().startsWith(delimiter)) {
      value.push(lines[i] ?? '');
      i += 1;
    }
    const joined = value.join('\n').trim();
    if (name !== undefined && !file && blankIfLiteral(name, joined, blanked) !== joined) {
      out.push('');
    } else {
      out.push(...value);
    }
  }
  return out.join('\n');
}

/** The part of a qualified XML name after its last `:`. */
function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/** True for a character an element name may start with, so a lone `<` in text is not read as a tag. */
function startsName(c: string): boolean {
  return /[A-Za-z_:]/.test(c) || c > '\u007f';
}

/**
 * Hands each literal credential in an XML text to `onLiteral` and returns the text with each value
 * it answers with put in place; `undefined` keeps the value. A literal credential is an attribute
 * whose local name looks like a credential (never an `xmlns` declaration), or a text or CDATA run
 * whose innermost element's local name does; a value made only of references, or of nothing but
 * white space, is never handed over.
 *
 * One forward scan driven by `indexOf`, so its time is linear in the text whatever it holds:
 * comments, processing instructions and `<!DOCTYPE …>` (with an internal subset up to `]>`) are
 * skipped; a quoted attribute value jumps to its closing quote, so a `>` inside it is safe; the
 * element names are kept on a stack that tolerates a mismatched end tag by closing the innermost.
 * An unterminated construct ends the scan with the rest of the text copied as written, except that
 * an unterminated credential attribute value or CDATA run is handed over first. Pure.
 */
export function scanXml(text: string, onLiteral: (name: string, value: string) => string | undefined): string {
  const out: string[] = [];
  const stack: string[] = [];
  /** Beside `stack`: whether each element's name looks like a credential, decided once when it opens. */
  const credential: boolean[] = [];
  let copied = 0;
  /** Hands over `text[start, end)` under `name` when it is a literal credential. */
  const visit = (name: string, start: number, end: number): void => {
    const value = text.slice(start, end);
    if (value.trim() === '' || referencesOnly(value)) return;
    const replacement = onLiteral(name, value);
    if (replacement === undefined || replacement === value) return;
    out.push(text.slice(copied, start), replacement);
    copied = end;
  };
  const visitRun = (start: number, end: number): void => {
    const name = stack[stack.length - 1];
    if (end > start && name !== undefined && credential[credential.length - 1] === true) visit(name, start, end);
  };
  const n = text.length;
  let i = 0;
  let run = 0;
  /** The text with the replacements in; a `complete` scan hands over the last text run first. */
  const finish = (complete: boolean): string => {
    if (complete) visitRun(run, n);
    out.push(text.slice(copied));
    return out.join('');
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    const next = text.charAt(lt + 1);
    if (next !== '!' && next !== '?' && next !== '/' && !startsName(next)) {
      // A `<` that opens no markup is part of the text run.
      i = lt + 1;
      continue;
    }
    visitRun(run, lt);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return finish(false);
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) {
        // An unterminated CDATA under a credential element still holds the credential.
        visitRun(lt + 9, n);
        return finish(false);
      }
      visitRun(lt + 9, end);
      i = end + 3;
    } else if (next === '?') {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) return finish(false);
      i = end + 2;
    } else if (next === '!') {
      // A declaration: `>` ends it, unless an internal subset opens first, which `]>` ends.
      let j = lt + 2;
      for (;;) {
        if (j >= n) return finish(false);
        const c = text.charAt(j);
        if (c === '>') {
          i = j + 1;
          break;
        }
        if (c === '[') {
          const end = text.indexOf(']>', j + 1);
          if (end === -1) return finish(false);
          i = end + 2;
          break;
        }
        if (c === '"' || c === "'") {
          const close = text.indexOf(c, j + 1);
          if (close === -1) return finish(false);
          j = close;
        }
        j += 1;
      }
    } else if (next === '/') {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) return finish(false);
      stack.pop();
      credential.pop();
      i = end + 1;
    } else {
      let j = lt + 1;
      while (j < n && !isSpace(text.charAt(j)) && text.charAt(j) !== '>' && text.charAt(j) !== '/') j += 1;
      const element = text.slice(lt + 1, j);
      let selfClosing = false;
      for (;;) {
        while (j < n && isSpace(text.charAt(j))) j += 1;
        if (j >= n) return finish(false);
        const c = text.charAt(j);
        if (c === '>') break;
        if (c === '/') {
          if (text.charAt(j + 1) === '>') {
            selfClosing = true;
            j += 1;
            break;
          }
          j += 1;
          continue;
        }
        const nameStart = j;
        while (j < n && !isSpace(text.charAt(j)) && !'=>/'.includes(text.charAt(j))) j += 1;
        const attribute = text.slice(nameStart, j);
        while (j < n && isSpace(text.charAt(j))) j += 1;
        if (text.charAt(j) !== '=') continue;
        j += 1;
        while (j < n && isSpace(text.charAt(j))) j += 1;
        if (j >= n) return finish(false);
        const quote = text.charAt(j);
        let valueStart = j;
        let valueEnd: number;
        const declaration = attribute === 'xmlns' || attribute.startsWith('xmlns:');
        const secret = !declaration && isCredentialName(localName(attribute));
        if (quote === '"' || quote === "'") {
          const close = text.indexOf(quote, j + 1);
          if (close === -1) {
            // An unterminated value runs to the end of the text, and is still a credential.
            if (secret) visit(attribute, j + 1, n);
            return finish(false);
          }
          valueStart = j + 1;
          valueEnd = close;
          j = close + 1;
        } else {
          while (j < n && !isSpace(text.charAt(j)) && text.charAt(j) !== '>') j += 1;
          valueEnd = j;
        }
        if (secret) visit(attribute, valueStart, valueEnd);
      }
      if (!selfClosing) {
        stack.push(element);
        credential.push(isCredentialName(localName(element)));
      }
      i = j + 1;
    }
    run = i;
  }
  return finish(true);
}

/** An XML text with each literal credential value blanked, its element or attribute name added to `blanked`. */
export function blankXmlText(text: string, blanked: Set<string>): string {
  return scanXml(text, (name) => {
    blanked.add(name);
    return '';
  });
}

/**
 * Text with literal credentials blanked by its `Content-Type`. Without one, text that opens like
 * JSON (`{` or `[`) is blanked as JSON, in place when it does not parse (a rewritten `${n}` breaks
 * it), text that opens like XML (`<`) is blanked as XML, and any other text is kept as written.
 */
export function blankText(text: string, contentType: string | undefined, blanked: Set<string>): string {
  const mime = contentType?.toLowerCase() ?? '';
  if (mime.includes('json')) return blankJsonText(text, blanked);
  if (mime.includes('xml')) return blankXmlText(text, blanked);
  if (mime.includes('x-www-form-urlencoded')) return blankFormText(text, blanked);
  if (mime.startsWith('multipart/') && contentType !== undefined) return blankMultipartText(text, contentType, blanked);
  if (contentType === undefined) {
    const first = text.trimStart().charAt(0);
    if (first === '{' || first === '[') return blankJsonText(text, blanked);
    if (first === '<') return blankXmlText(text, blanked);
  }
  return text;
}
