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
import { rewriteMustache } from '../templates.js';
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

interface RewriteContext {
  readonly dynamic: Set<string>;
  readonly chained: Set<string>;
}

const PROCESS_ENV = /\{\{\s*\$processEnv\s+([A-Za-z_]\w*)\s*\}\}/g;
const CHAINING = /\{\{\s*[\w-]+\.(?:response|request)\.[^{}]*\}\}/g;
/** A value made of `${…}` references and nothing else: no literal to keep out of the project. */
const REFERENCES_ONLY = /^\s*(?:\$\{[^{}]+\}\s*)+$/;
const AUTH_REFERENCES_ONLY = /^\s*(?:Bearer|Basic)\s+(?:\$\{[^{}]+\}\s*)+$/i;
const ORIGIN = /^https?:\/\/[^/?#]+/i;
const LEADING_REFERENCE = /^\$\{[^{}]+\}/;
const ANY_ORIGIN = /^[a-z][\w+.-]*:\/\/[^/?#]*/i;
const TIMEOUT = /^(\d+)\s*(ms|s|m)?$/i;
/** A `"key": "value"` pair, for blanking credentials in a JSON body that does not parse. */
const JSON_STRING_PAIR = /"((?:[^"\\\n]|\\.)*)"(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g;

/** Rewrites a .http value: $processEnv → ${#System#X}, request chaining kept as written (and reported), then {{x}} → ${x}. */
function rewriteValue(text: string, ctx: RewriteContext): string {
  const kept: string[] = [];
  const shielded = text
    .replace(PROCESS_ENV, (_m, name: string) => `\u0000S${name}\u0000`)
    .replace(CHAINING, (m) => {
      ctx.chained.add(m);
      kept.push(m);
      return `\u0000C${kept.length - 1}\u0000`;
    });
  return rewriteMustache(shielded, ctx.dynamic)
    .replace(/\u0000S(\w+)\u0000/g, (_m, name: string) => `\${#System#${name}}`)
    .replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? '');
}

function referencesOnly(value: string): boolean {
  return REFERENCES_ONLY.test(value);
}

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
 * A JSON body with its literal credential values blanked, re-serialised only when one was. A body
 * that does not parse (an unquoted `${n}`, say) has its `"key": "value"` string pairs blanked in
 * place instead.
 */
function blankJsonText(text: string, blanked: Set<string>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.replace(JSON_STRING_PAIR, (match, key: string, sep: string, value: string) => {
      if (blankIfLiteral(key, value, blanked) === value) return match;
      return `"${key}"${sep}""`;
    });
  }
  const found = new Set<string>();
  const out = blankJson(parsed, found);
  if (found.size === 0) return text;
  for (const key of found) blanked.add(key);
  return JSON.stringify(out, null, /\n( +)\S/.exec(text)?.[1]?.length);
}

function headerValue(headers: readonly KeyValueEntry[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

/** The request body, from its `Content-Type`. Literal credential values in JSON and form bodies are blanked. */
function mapBody(
  request: HttpFileRequest,
  contentType: string | undefined,
  options: MapHttpFileOptions,
  ctx: RewriteContext,
  label: string,
  report: ReportBuilder,
  blanked: Set<string>,
): RestBody {
  const body = request.body;
  if (body === undefined) return NO_BODY;
  if (body.kind === 'file') {
    const rel = rewriteValue(body.path, ctx);
    const absolute = /^(?:[A-Za-z]:)?[\\/]/.test(rel);
    if (options.fileDir === undefined && !absolute) {
      report.warn(
        `${label}: the body file ${rel} is relative to the original .http file; check its path on the request.`,
      );
    }
    const path = options.fileDir === undefined ? rel : resolvePath(options.fileDir, rel);
    return { kind: 'binary', source: { kind: 'path', path }, contentType: contentType ?? 'application/octet-stream' };
  }
  const text = rewriteValue(body.text, ctx);
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
  return { kind: 'raw', language: 'text', ...(contentType !== undefined ? { contentType } : {}), text };
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
  const ctx: RewriteContext = { dynamic: new Set(), chained: new Set() };

  const properties = new VariableSetBuilder('Project properties', report);
  for (const variable of parsed.variables) {
    const value = rewriteValue(variable.value, ctx);
    // No literal credential in a project file: one under a credential-looking name goes to the secret store.
    const secret = value !== '' && isCredentialName(variable.name) && !referencesOnly(value);
    properties.add(
      secret
        ? { name: variable.name, value: '', enabled: true, secret: true, secretValue: value }
        : { name: variable.name, value, enabled: true, secret: false },
    );
  }

  const restSlug = slugify(options.name);
  const scriptDir = restSlug.toLowerCase();
  const urls = new Map<HttpFileRequest, ReturnType<typeof splitUrl>>();
  for (const request of parsed.requests) urls.set(request, splitUrl(rewriteValue(request.url, ctx)));

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
    const { path: url, query: rawQuery } = urls.get(request) ?? { path: '', query: [] };
    const name = request.name ?? `${request.method} ${pathOf(url)}`;
    const label = name;
    const blanked = new Set<string>();
    const query = rawQuery.map((q) => entry(q.name, blankIfLiteral(q.name, q.value, blanked)));
    const rewritten = request.headers.map((h) => ({ name: h.name, value: rewriteValue(h.value, ctx) }));
    const { headers, auth } = headersAndAuth(rewritten, label, report, blanked);

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

    if (request.method === 'WEBSOCKET') {
      for (const directive of request.directives) {
        report.note(`${label}: the "@${directive.name}" directive has no Wirebench equivalent and was ignored.`);
      }
      let content: string | undefined;
      if (request.body?.kind === 'inline') content = rewriteValue(request.body.text, ctx);
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
