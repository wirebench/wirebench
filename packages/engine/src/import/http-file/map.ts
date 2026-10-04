/**
 * Turns a parsed `.http` file into one REST API, plus a WebSocket API for its `WEBSOCKET`
 * requests, with the file variables as project properties and the response handlers kept as text.
 *
 * In core, not `rest/`, because one file becomes two protocols' APIs and a protocol folder never
 * imports another (protocol modules spec §7.2); its imports of `rest/` and `ws/` are listed
 * exceptions. Pure (no `node:` modules, no `Buffer`), but it creates ids, so format detection
 * never imports it: detection reaches `rest/http-file/parse.ts` only.
 */

import { isCredentialName } from '../credentials.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import type { ImportedScriptFile } from '../scripts.js';
import { importedScriptPath } from '../scripts.js';
import type { ImportedVariableSet } from '../variables.js';
import { VariableSetBuilder } from '../variables.js';
import type { AuthConfig, IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { slugify, uniqueSlug } from '../../project/paths.js';
import type { WsApi, WsRequestDef } from '../../ws/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../ws/model.js';
import type { KeyValueEntry, RestApi, RestBody, RestRequestDef, RestRequestSettings } from '../../rest/model.js';
import { NO_BODY, createApi, createRestRequest, entry } from '../../rest/model.js';
import { splitQuery } from '../../rest/url.js';
import type { HttpFileRequest, ParsedHttpFile } from '../../rest/http-file/parse.js';
import type { HttpRewriteContext } from '../../rest/http-file/values.js';
import {
  REFERENCE,
  USERINFO,
  looksLikeBareAuthority,
  newRewriteContext,
  referencesOnly,
  rewriteHttpValue,
  stripUserinfo,
} from '../../rest/http-file/values.js';

export interface MappedHttpFile {
  readonly rest: RestApi;
  /** Absent when the file has no `WEBSOCKET` request. */
  readonly websocket?: WsApi;
  readonly projectProperties: ImportedVariableSet;
  /** Response handlers, to be written under `imported-scripts/` and never run. */
  readonly scripts: readonly ImportedScriptFile[];
  readonly counts: { readonly requests: number; readonly websocket: number; readonly skipped: number };
  readonly report: ImportReport;
}

export interface MapHttpFileOptions {
  /** The REST API's name; the WebSocket API is named after it. */
  readonly name: string;
  /** The `.http` file's directory, which `< file` bodies are resolved against. */
  readonly fileDir?: string;
  readonly newId?: IdGenerator;
  /** The `order` of the REST API; the WebSocket API follows it. 0 by default. */
  readonly firstOrder?: number;
}

const AUTH_REFERENCES_ONLY = new RegExp(String.raw`^\s*(?:Bearer|Basic)\s+(?:${REFERENCE}\s*)+$`, 'i');
/**
 * A `{{name}}` written straight after `scheme://`: the variable holds the URL's authority. The
 * scheme is only looked behind for: an unanchored `[a-z][\w+.-]*` would rescan a long word from
 * each of its letters.
 */
const AUTHORITY_VARIABLE = /(?<=[a-z\d+.-]):\/\/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/gi;
const ORIGIN = /^https?:\/\/[^/?#]+/i;
const LEADING_REFERENCE = /^\$\{[^{}]+\}/;
const ANY_ORIGIN = /^[a-z][\w+.-]*:\/\/[^/?#]*/i;
const TIMEOUT = /^(\d+)\s*(ms|s|m)?$/i;
/** A `"key": value` pair whose value is a string, number or boolean, for blanking JSON in place. */
const JSON_PAIR = /"((?:[^"\\\n]|\\.)*)"(\s*:\s*)("(?:[^"\\\n]|\\.)*"|-?\d[\w.+-]*|true|false)/g;

/** `value` unless it is a literal credential under a credential-looking `name`; then `''`, with `name` added to `blanked`. */
function blankIfLiteral(name: string, value: string, blanked: Set<string>): string {
  if (value === '' || !isCredentialName(name) || referencesOnly(value)) return value;
  blanked.add(name);
  return '';
}

/**
 * {@link splitQuery}, but a `${#System#X}` reference is not mistaken for a fragment: every `${…}`
 * is shielded while the URL is split.
 */
function splitUrl(url: string): { path: string; query: KeyValueEntry[] } {
  const refs: string[] = [];
  const shielded = url.replace(/\$\{[^{}]*\}/g, (m) => {
    refs.push(m);
    return `\u0000${refs.length - 1}\u0000`;
  });
  const restore = (text: string): string =>
    text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => refs[Number(i)] ?? '');
  const { path, query } = splitQuery(shielded);
  return { path: restore(path), query: query.map((q) => entry(restore(q.name), restore(q.value))) };
}

/** The URL's path, without its origin or query, for naming an unnamed request. */
function pathOf(url: string): string {
  const path = url.replace(ANY_ORIGIN, '');
  const mark = path.indexOf('?');
  const cut = mark === -1 ? path : path.slice(0, mark);
  return cut === '' ? '/' : cut;
}

/** What a URL would share as a base URL: its origin, or its leading `${name}`. */
function baseCandidate(url: string): string | undefined {
  return ORIGIN.exec(url)?.[0] ?? LEADING_REFERENCE.exec(url)?.[0];
}

function cutBase(url: string, base: string): string {
  if (base === '' || !url.startsWith(base)) return url;
  const rest = url.slice(base.length);
  if (rest === '') return '/';
  return rest.startsWith('/') ? rest : url;
}

/**
 * `rel` resolved against `dir`, without `node:path`: either separator is understood, and the
 * result uses the one `dir` is written with.
 */
function resolvePath(dir: string, rel: string): string {
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
function headersAndAuth(
  headers: readonly { name: string; value: string }[],
  label: string,
  report: ReportBuilder,
  blanked: Set<string>,
): { headers: KeyValueEntry[]; auth: AuthConfig } {
  let auth: AuthConfig = { type: 'inherit' };
  const kept: KeyValueEntry[] = [];
  for (const header of headers) {
    const { name, value } = header;
    if (name.toLowerCase() === 'authorization') {
      if (AUTH_REFERENCES_ONLY.test(value) || referencesOnly(value) || value.trim() === '') {
        kept.push(entry(name, value));
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
    kept.push(entry(name, value));
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
function blankJsonText(text: string, blanked: Set<string>): string {
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
function blankFormText(text: string, blanked: Set<string>): string {
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
function blankMultipartText(text: string, contentType: string, blanked: Set<string>): string {
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
function blankText(text: string, contentType: string | undefined, blanked: Set<string>): string {
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

function headerValue(headers: readonly KeyValueEntry[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

/** The request body, from its `Content-Type`. Literal credential values in JSON and form bodies are blanked. */
function mapBody(
  request: HttpFileRequest,
  contentType: string | undefined,
  options: MapHttpFileOptions,
  ctx: HttpRewriteContext,
  label: string,
  report: ReportBuilder,
  blanked: Set<string>,
): RestBody {
  const body = request.body;
  if (body === undefined) return NO_BODY;
  if (body.kind === 'file') {
    const rel = rewriteHttpValue(body.path, ctx);
    const absolute = /^(?:[A-Za-z]:)?[\\/]/.test(rel);
    if (options.fileDir === undefined && !absolute) {
      report.warn(
        `${label}: the body file ${rel} is relative to the original .http file; check its path on the request.`,
      );
    }
    const path = options.fileDir === undefined ? rel : resolvePath(options.fileDir, rel);
    return { kind: 'binary', source: { kind: 'path', path }, contentType: contentType ?? 'application/octet-stream' };
  }
  const text = rewriteHttpValue(body.text, ctx);
  const mime = contentType?.toLowerCase() ?? '';
  if (mime.includes('json')) return { kind: 'raw', language: 'json', text: blankJsonText(text, blanked) };
  if (mime.includes('xml')) return { kind: 'raw', language: 'xml', text };
  if (mime.includes('x-www-form-urlencoded')) {
    return {
      kind: 'form',
      fields: [...new URLSearchParams(text)].map(([n, v]) => entry(n, blankIfLiteral(n, v, blanked))),
    };
  }
  if (mime.startsWith('multipart/')) report.note(`${label}: the multipart body was kept as raw text.`);
  return {
    kind: 'raw',
    language: 'text',
    ...(contentType !== undefined ? { contentType } : {}),
    text: blankText(text, contentType, blanked),
  };
}

/** The settings the directives ask for; any directive without an equivalent is noted. */
function settingsFrom(request: HttpFileRequest, label: string, report: ReportBuilder): RestRequestSettings {
  let settings: RestRequestSettings = {};
  for (const directive of request.directives) {
    if (directive.name === 'no-redirect') {
      settings = { ...settings, followRedirects: false };
      continue;
    }
    const timeout = directive.name === 'timeout' ? TIMEOUT.exec(directive.value ?? '') : null;
    if (timeout) {
      const n = Number(timeout[1]);
      const unit = timeout[2]?.toLowerCase();
      const timeoutMs =
        unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n < 1000 ? n * 1000 : n;
      settings = { ...settings, timeoutMs };
      continue;
    }
    report.note(`${label}: the "@${directive.name}" directive has no Wirebench equivalent and was ignored.`);
  }
  return settings;
}

/** Maps a parsed `.http` file to a REST API and, when it has `WEBSOCKET` requests, a WebSocket API. */
export function mapHttpFile(parsed: ParsedHttpFile, options: MapHttpFileOptions): MappedHttpFile {
  const newId = options.newId ?? generateId;
  const firstOrder = options.firstOrder ?? 0;
  const report = new ReportBuilder();
  const ctx = newRewriteContext();

  const properties = new VariableSetBuilder('Project properties', report);
  const seen = new Set<string>();
  const secrets: string[] = [];
  const authorities = new Set<string>();
  for (const request of parsed.requests) {
    for (const match of request.url.matchAll(AUTHORITY_VARIABLE)) authorities.add(match[1] ?? '');
  }
  for (const variable of parsed.variables) {
    const raw = rewriteHttpValue(variable.value, ctx);
    const first = !seen.has(variable.name);
    seen.add(variable.name);
    // No literal credential in a project file: one under a credential-looking name goes to the
    // secret store whole; any other value loses literal user info from a URL.
    if (raw !== '' && isCredentialName(variable.name) && !referencesOnly(raw)) {
      if (first) secrets.push(variable.name);
      properties.add({ name: variable.name, value: '', enabled: true, secret: true, secretValue: raw });
      continue;
    }
    const bare =
      looksLikeBareAuthority(raw) || (!USERINFO.test(raw) && authorities.has(variable.name) && raw.includes('@'));
    const { url: value, stripped } = stripUserinfo(raw, bare);
    if (stripped && first) {
      report.warn(`Project properties: the credential in the URL of "${variable.name}" was not imported.`);
    }
    properties.add({ name: variable.name, value, enabled: true, secret: false });
  }
  if (secrets.length > 0) {
    report.note(
      `Project properties: ${secrets.join(', ')} look like credentials; their values were stored as secrets.`,
    );
  }

  const restSlug = slugify(options.name);
  const scriptDir = restSlug.toLowerCase();
  const urls = new Map<HttpFileRequest, ReturnType<typeof splitUrl> & { stripped: boolean; username?: string }>();
  for (const request of parsed.requests) {
    const { url, ...userinfo } = stripUserinfo(rewriteHttpValue(request.url, ctx));
    urls.set(request, { ...splitUrl(url), ...userinfo });
  }

  const restRequests = parsed.requests.filter(
    (r) => r.method !== 'WEBSOCKET' && r.method !== 'GRAPHQL' && r.method !== 'GRPC',
  );
  const candidates = restRequests.map((r) => baseCandidate(urls.get(r)?.path ?? ''));
  const first = candidates[0];
  const baseUrl = first !== undefined && candidates.every((c) => c === first) ? first : '';

  const scripts: ImportedScriptFile[] = [];
  const scriptPaths = new Set<string>();
  const rest: RestRequestDef[] = [];
  const restSlugs = new Set<string>();
  const ws: WsRequestDef[] = [];
  const wsSlugs = new Set<string>();
  let skipped = 0;

  for (const request of parsed.requests) {
    if (request.method === 'GRAPHQL') {
      report.warn(`The GRAPHQL request at line ${request.line} was skipped: GraphQL support is tracked in #77.`);
      skipped += 1;
      continue;
    }
    if (request.method === 'GRPC') {
      report.warn(
        `The GRPC request at line ${request.line} was skipped: a gRPC request needs a definition; import its .proto.`,
      );
      skipped += 1;
      continue;
    }
    const {
      path: url,
      query: rawQuery,
      stripped,
      username,
    } = urls.get(request) ?? { path: '', query: [], stripped: false };
    const name = request.name ?? `${request.method} ${pathOf(url)}`;
    const label = name;
    const blanked = new Set<string>();
    const query = rawQuery.map((q) => entry(q.name, blankIfLiteral(q.name, q.value, blanked)));
    const rewritten = request.headers.map((h) => ({ name: h.name, value: rewriteHttpValue(h.value, ctx) }));
    const mapped = headersAndAuth(rewritten, label, report, blanked);
    const { headers } = mapped;
    let { auth } = mapped;
    if (stripped) {
      report.warn(`${label}: the credential in the URL was not imported; set it on the request.`);
      // An Authorization header, kept or not, already says how the request authenticates.
      if (!rewritten.some((h) => h.name.toLowerCase() === 'authorization')) {
        auth = { type: 'basic', ...(username !== undefined ? { username } : {}) };
      }
    }

    for (const handler of request.handlers) {
      if (handler.kind === 'file') {
        report.note(`${label}: the response handler file ${handler.text} was not copied.`);
        continue;
      }
      const path = importedScriptPath(scriptDir, slugify(name).toLowerCase(), 'handler.js', scriptPaths);
      scripts.push({ path, source: handler.text });
      report.note(`${label}: the response handler was saved to ${path} and is never run.`);
    }
    if (request.redirects > 0) report.note(`${label}: ${request.redirects} output redirect line(s) were ignored.`);
    for (const line of request.ignoredLines) {
      report.note(`${label}: line ${line} among the headers is not a header and was ignored.`);
    }

    if (request.method === 'WEBSOCKET') {
      for (const directive of request.directives) {
        report.note(`${label}: the "@${directive.name}" directive has no Wirebench equivalent and was ignored.`);
      }
      let content: string | undefined;
      if (request.body?.kind === 'inline') {
        content = blankText(rewriteHttpValue(request.body.text, ctx), headerValue(headers, 'content-type'), blanked);
      }
      if (request.body?.kind === 'file')
        report.note(`${label}: the message file ${request.body.path} was not imported.`);
      const slug = uniqueSlug(name, wsSlugs);
      wsSlugs.add(slug);
      ws.push(
        createWsRequest(name, {
          newId,
          order: ws.length,
          slug,
          url,
          query,
          headers,
          auth,
          messages: content === undefined ? [] : [createWsSavedMessage('Message', { newId, content, format: 'text' })],
        }),
      );
    } else {
      const body = mapBody(request, headerValue(headers, 'content-type'), options, ctx, label, report, blanked);
      const slug = uniqueSlug(name, restSlugs);
      restSlugs.add(slug);
      rest.push(
        createRestRequest(name, {
          newId,
          order: rest.length,
          slug,
          method: request.method,
          url: cutBase(url, baseUrl),
          query,
          headers,
          body,
          auth,
          settings: settingsFrom(request, label, report),
        }),
      );
    }
    if (blanked.size > 0) {
      report.warn(
        `${label}: the recorded value of ${[...blanked].join(', ')} was not imported; set it on the request.`,
      );
    }
  }

  if (ctx.chained.size > 0) {
    report.warn(
      `These request-chaining references were kept as written and need a script or a property capture: ${[...ctx.chained].join(', ')}`,
    );
  }
  if (ctx.dynamic.size > 0) {
    report.warn(`Dynamic variables are kept as written and not expanded: ${[...ctx.dynamic].sort().join(', ')}`);
  }

  const restApi = createApi(options.name, {
    newId,
    order: firstOrder,
    slug: restSlug,
    baseUrl,
    servers: baseUrl === '' ? [] : [{ url: baseUrl }],
    requests: rest,
  });
  const websocket =
    ws.length === 0
      ? undefined
      : createWsApi(`${options.name} (WebSocket)`, { newId, order: firstOrder + 1, requests: ws });

  return {
    rest: restApi,
    ...(websocket !== undefined ? { websocket } : {}),
    projectProperties: properties.build(),
    scripts,
    counts: { requests: rest.length, websocket: ws.length, skipped },
    report: report.build(),
  };
}
