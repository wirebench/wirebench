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
import { REFERENCE, referencesOnly } from './values.js';

const AUTH_REFERENCES_ONLY = new RegExp(String.raw`^\s*(?:Bearer|Basic)\s+(?:${REFERENCE}\s*)+$`, 'i');
/** A `"key": value` pair whose value is a string, number or boolean, for blanking JSON in place. */
const JSON_PAIR = /"((?:[^"\\\n]|\\.)*)"(\s*:\s*)("(?:[^"\\\n]|\\.)*"|-?\d[\w.+-]*|true|false)/g;

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
  const inPlace = text.replace(JSON_PAIR, (match, key: string, sep: string, value: string) => {
    const bare = value.startsWith('"') ? value.slice(1, -1) : value;
    if (blankIfLiteral(key, bare, blanked) === bare) return match;
    return `"${key}"${sep}""`;
  });
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

/**
 * Text with literal credentials blanked by its `Content-Type`. Without one, text that opens like
 * JSON (`{` or `[`) is blanked as JSON, in place when it does not parse (a rewritten `${n}` breaks
 * it), and text that does not is kept as written.
 */
export function blankText(text: string, contentType: string | undefined, blanked: Set<string>): string {
  const mime = contentType?.toLowerCase() ?? '';
  if (mime.includes('json')) return blankJsonText(text, blanked);
  if (mime.includes('x-www-form-urlencoded')) return blankFormText(text, blanked);
  if (mime.startsWith('multipart/') && contentType !== undefined) return blankMultipartText(text, contentType, blanked);
  if (contentType === undefined) {
    const first = text.trimStart().charAt(0);
    return first === '{' || first === '[' ? blankJsonText(text, blanked) : text;
  }
  return text;
}
