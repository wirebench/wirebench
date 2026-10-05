/**
 * Turns a parsed `.http` file into one REST API, plus a WebSocket API for its `WEBSOCKET`
 * requests, with the file variables as project properties and the response handlers kept as text.
 *
 * In core, not `rest/`, because one file becomes two protocols' APIs and a protocol folder never
 * imports another (protocol modules spec §7.2); its imports of `rest/` and `ws/` are listed
 * exceptions. Pure (no `node:` modules, no `Buffer`), but it creates ids, so format detection
 * never imports it: detection reaches `rest/http-file/parse.ts` only.
 */

import {
  blankIfLiteral,
  blankJsonText,
  blankText,
  blankXmlText,
  headersAndAuth,
  resolvePath,
} from '../credential-values.js';
import { isCredentialName } from '../credentials.js';
import type { ImportReport } from '../report.js';
import { ReportBuilder } from '../report.js';
import type { ImportedScriptFile } from '../scripts.js';
import { importedScriptPath } from '../scripts.js';
import type { ImportedVariableSet } from '../variables.js';
import { VariableSetBuilder } from '../variables.js';
import type { IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { slugify, uniqueSlug } from '../../project/paths.js';
import type { WsApi, WsRequestDef } from '../../ws/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../ws/model.js';
import type { KeyValueEntry, RestApi, RestBody, RestRequestDef, RestRequestSettings } from '../../rest/model.js';
import { NO_BODY, createApi, createRestRequest, entry } from '../../rest/model.js';
import { splitQueryKeepingReferences as splitUrl } from '../../rest/url.js';
import type { HttpFileRequest, ParsedHttpFile } from '../../rest/http-file/parse.js';
import type { HttpRewriteContext } from '../../rest/http-file/values.js';
import { newRewriteContext, rewriteHttpValue } from '../../rest/http-file/values.js';
import { USERINFO, looksLikeBareAuthority, referencesOnly, stripUserinfo } from '../values.js';

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

function headerValue(headers: readonly KeyValueEntry[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

/** The request body, from its `Content-Type`. Literal credential values in JSON, XML and form bodies are blanked. */
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
  if (mime.includes('xml')) return { kind: 'raw', language: 'xml', text: blankXmlText(text, blanked) };
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
