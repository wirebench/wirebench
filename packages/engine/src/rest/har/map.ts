/**
 * Turns a parsed HAR log into REST APIs: one API per origin, one request per distinct method, path
 * and set of query names, with the recorded responses kept as examples or handed back as exchanges
 * for History.
 *
 * Not browser-safe (`Buffer`): format detection imports `parse.ts` only, never this module.
 */

import type { ImportReport } from '../../import/report.js';
import { ReportBuilder } from '../../import/report.js';
import type { AuthConfig, IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { uniqueSlug } from '../../project/paths.js';
import {
  REDACTED_MARKER,
  SECRET_BODY_KEYS,
  isSensitiveHeaderName,
  isSensitiveQueryParam,
  redactStructuredBody,
} from '../../redact/index.js';
import type { RawLanguage, RestApi, RestBody, RestRequestDef, RestResponseExample } from '../model.js';
import { NO_BODY, createApi, createRestRequest, entry } from '../model.js';
import type { HarEntryIn, HarLogIn, HarNameValue, HarPostData } from './model.js';

/** What happens to the recorded responses: left out, kept as request examples, or sent to History. */
export type HarResponseMode = 'drop' | 'history' | 'examples';

export interface MapHarOptions {
  /** Keep scripts, stylesheets, images, fonts and media. Off by default. */
  readonly includeStaticAssets?: boolean;
  /** `drop` by default. */
  readonly responses?: HarResponseMode;
  readonly newId?: IdGenerator;
  /** The `order` of the first API; the rest follow it. 0 by default. */
  readonly firstOrder?: number;
}

/** One kept entry's recorded exchange, for History (spec §5.5). Headers are NOT redacted here; main redacts. */
export interface HarRecordedExchange {
  readonly requestId: string;
  readonly at: string;
  readonly durationMs: number;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: readonly HarNameValue[];
  readonly requestBody: string;
  readonly status: number;
  readonly statusText: string;
  readonly responseHeaders: readonly HarNameValue[];
  readonly responseBody?: string;
}

export interface MappedHar {
  readonly apis: readonly RestApi[];
  /** Empty unless `responses` is `history`. */
  readonly exchanges: readonly HarRecordedExchange[];
  readonly summary: {
    readonly entries: number;
    readonly kept: number;
    readonly requests: number;
    readonly apis: number;
    readonly statuses: Readonly<Record<string, number>>;
  };
  readonly report: ImportReport;
}

const STATIC_TYPES = new Set(['image', 'font', 'stylesheet', 'script', 'media']);
const STATIC_MIME = /^(image|font|audio|video)\/|^text\/css\b|javascript/i;
const STATIC_EXT = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|css|js|mjs|map|mp4|webm|mp3|wav)$/i;
/** Request headers never saved: pseudo-headers aside, the transport's own and the cookies. */
const DROPPED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'cookie',
  'authorization',
]);
/** Response headers an example never keeps: the cookie jar, not the example, owns cookies. */
const DROPPED_EXAMPLE_HEADERS = new Set(['set-cookie', 'cookie']);
const TEXTUAL = /^(text\/|application\/(json|xml|[\w.+-]+\+(json|xml)|x-www-form-urlencoded|javascript))/i;
const MAX_EXAMPLES = 5;

function isStatic(e: HarEntryIn, url: URL): boolean {
  return (
    (e.resourceType !== undefined && STATIC_TYPES.has(e.resourceType)) ||
    STATIC_MIME.test(e.response.content.mimeType) ||
    STATIC_EXT.test(url.pathname)
  );
}

function isPreflight(e: HarEntryIn): boolean {
  return (
    e.request.method.toUpperCase() === 'OPTIONS' &&
    e.request.headers.some((h) => h.name.toLowerCase() === 'access-control-request-method')
  );
}

function dedupeKey(method: string, url: URL): string {
  const names = [...new Set(url.searchParams.keys())].sort();
  return `${method} ${url.pathname} ?${names.join('&')}`;
}

function bodyText(content: HarEntryIn['response']['content']): string | undefined {
  if (content.text === undefined) return undefined;
  if (content.encoding !== 'base64') return content.text;
  return TEXTUAL.test(content.mimeType) ? Buffer.from(content.text, 'base64').toString('utf8') : undefined;
}

/** The user name of a Basic credential, when the value decodes to printable `user:password` text. */
function basicUsername(encoded: string): string | undefined {
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  if (!decoded.includes(':') || /[\u0000-\u001f\u007f\ufffd]/.test(decoded)) return undefined;
  const username = decoded.slice(0, decoded.indexOf(':'));
  return username !== '' ? username : undefined;
}

/**
 * The request's auth, without its secret: Bearer and Basic from `Authorization` (Basic keeps its
 * user name), any other scheme as `none`; with no `Authorization`, an `X-Api-Key` header becomes
 * API-key auth under the name it was recorded with.
 */
function authFrom(headers: readonly HarNameValue[], label: string, report: ReportBuilder): AuthConfig {
  const value = headers.find((h) => h.name.toLowerCase() === 'authorization')?.value;
  if (value === undefined) {
    const apiKey = headers.find((h) => h.name.toLowerCase() === 'x-api-key');
    return apiKey !== undefined ? { type: 'api-key', in: 'header', name: apiKey.name } : { type: 'inherit' };
  }
  const [scheme = '', rest = ''] = value.trim().split(/\s+/, 2);
  if (scheme.toLowerCase() === 'bearer' || scheme.toLowerCase() === 'basic') {
    report.warn(`${label}: the recorded Authorization credential was not imported; set it on the request or API.`);
  }
  if (scheme.toLowerCase() === 'bearer') return { type: 'bearer' };
  if (scheme.toLowerCase() === 'basic') {
    const username = basicUsername(rest);
    return { type: 'basic', ...(username !== undefined ? { username } : {}) };
  }
  // Name the scheme only when the value is clearly `<scheme> <credentials>`; a scheme-less value
  // would otherwise put the credential itself into the report.
  if (/^[A-Za-z][\w-]*$/.test(scheme) && rest !== '') {
    report.warn(`${label}: ${scheme} authentication is not supported and was imported as none.`);
  } else {
    report.warn(`${label}: the Authorization header has an unrecognised form and was imported as none.`);
  }
  return { type: 'none' };
}

const SECRET_BODY_KEY_SET = new Set(SECRET_BODY_KEYS);

function isSecretBodyKey(name: string): boolean {
  return SECRET_BODY_KEY_SET.has(name.toLowerCase());
}

/**
 * A copy of a parsed JSON body with every secret-keyed value blanked (a nested object or array
 * under one too), adding each key it blanks to `blanked`.
 */
function blankJson(value: unknown, blanked: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => blankJson(item, blanked));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        if (!isSecretBodyKey(key)) return [key, blankJson(inner, blanked)];
        blanked.add(key);
        return [key, ''];
      }),
    );
  }
  return value;
}

/** A JSON body with its secret-keyed values blanked; the text as recorded when none matched or it does not parse. */
function blankJsonText(text: string, blanked: Set<string>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const found = new Set<string>();
  const out = blankJson(parsed, found);
  if (found.size === 0) return text;
  for (const key of found) blanked.add(key);
  return JSON.stringify(out, null, /\n( +)\S/.exec(text)?.[1]?.length);
}

/** `value`, or `''` when `name` is a secret body key (and `name` is added to `blanked`). */
function blankIfSecret(name: string, value: string, blanked: Set<string>): string {
  if (!isSecretBodyKey(name) || value === '') return value;
  blanked.add(name);
  return '';
}

/**
 * The headers a saved request keeps. Any other credential header (`Proxy-Authorization`,
 * `X-Api-Key`, whose shape {@link authFrom} keeps) is dropped with a warning, so no literal secret
 * is saved.
 */
function requestHeaders(headers: readonly HarNameValue[], label: string, report: ReportBuilder): HarNameValue[] {
  return headers.filter((h) => {
    const lower = h.name.toLowerCase();
    if (h.name.startsWith(':') || DROPPED_HEADERS.has(lower)) return false;
    if (isSensitiveHeaderName(lower)) {
      if (lower !== 'set-cookie') {
        report.warn(`${label}: the recorded ${h.name} credential was not imported; set it on the request or API.`);
      }
      return false;
    }
    return true;
  });
}

/**
 * The request body. Secret-keyed form fields, multipart text parts and JSON values are blanked,
 * each name added to `blanked`; any other body is kept as recorded.
 */
function mapPostData(
  post: HarPostData | undefined,
  label: string,
  report: ReportBuilder,
  blanked: Set<string>,
): RestBody {
  if (post === undefined || (post.text === undefined && post.params === undefined)) return NO_BODY;
  const mime = post.mimeType.toLowerCase();
  if (mime.includes('x-www-form-urlencoded')) {
    const pairs = post.params?.map((p) => [p.name, p.value ?? ''] as const) ?? [
      ...new URLSearchParams(post.text ?? ''),
    ];
    return { kind: 'form', fields: pairs.map(([n, v]) => entry(n, blankIfSecret(n, v, blanked))) };
  }
  if (mime.startsWith('multipart/form-data') && post.params !== undefined) {
    return {
      kind: 'multipart',
      parts: post.params.map((p) => {
        const contentType = p.contentType !== undefined ? { contentType: p.contentType } : {};
        if (p.fileName === undefined) {
          const value = blankIfSecret(p.name, p.value ?? '', blanked);
          return { kind: 'text' as const, name: p.name, value, enabled: true, ...contentType };
        }
        report.note(
          `${label}: the file part "${p.name}" (${p.fileName}) has no file attached; pick it on the request.`,
        );
        return {
          kind: 'file' as const,
          name: p.name,
          source: { kind: 'path' as const, path: '' },
          enabled: true,
          fileName: p.fileName,
          ...contentType,
        };
      }),
    };
  }
  const language: RawLanguage = mime.includes('json') ? 'json' : mime.includes('xml') ? 'xml' : 'text';
  const text = post.text ?? '';
  return {
    kind: 'raw',
    language,
    ...(post.mimeType !== '' ? { contentType: post.mimeType } : {}),
    text: language === 'json' ? blankJsonText(text, blanked) : text,
  };
}

function markers(text: string): number {
  return text.split(REDACTED_MARKER).length - 1;
}

/**
 * A recorded response as an example. Cookies are dropped, and credential headers and secret-keyed
 * body values are masked the way the HAR export masks them, so no literal credential is saved.
 */
function exampleOf(e: HarEntryIn, id: string, label: string, report: ReportBuilder): RestResponseExample {
  const { content } = e.response;
  let masked = false;
  const headers = e.response.headers
    .filter((h) => !DROPPED_EXAMPLE_HEADERS.has(h.name.toLowerCase()))
    .map((h) => {
      if (!isSensitiveHeaderName(h.name)) return entry(h.name, h.value);
      masked = true;
      return entry(h.name, REDACTED_MARKER);
    });
  let body = bodyText(content);
  if (body === undefined && content.text !== undefined) {
    report.note(`${label}: a binary response body was left out of the example.`);
  }
  if (body !== undefined) {
    const redacted = redactStructuredBody(body, content.mimeType !== '' ? content.mimeType : undefined);
    // Re-serialising may reformat JSON, so the redacted text replaces the body only when it masked something.
    if (markers(redacted) > markers(body)) {
      body = redacted;
      masked = true;
    }
  }
  if (masked) report.note(`${label}: credentials in a recorded response were masked in its example.`);
  return {
    id,
    name: `${e.response.status} ${e.response.statusText} — recorded ${e.startedDateTime.slice(0, 10)}`,
    status: e.response.status,
    statusText: e.response.statusText,
    headers,
    ...(content.mimeType !== '' ? { contentType: content.mimeType } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

/** `1 … was` or `N … were`. */
function counted(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one} was` : `${n} ${many} were`;
}

interface ApiDraft {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly order: number;
  readonly requests: Map<string, RestRequestDef>;
  readonly examples: Map<string, Map<number, RestResponseExample>>;
  readonly slugs: Set<string>;
}

/** Maps a parsed HAR log to REST APIs, in the order each origin is first seen. */
export function mapHar(log: HarLogIn, options: MapHarOptions = {}): MappedHar {
  const newId = options.newId ?? generateId;
  const firstOrder = options.firstOrder ?? 0;
  const responses = options.responses ?? 'drop';
  const report = new ReportBuilder();
  const drafts = new Map<string, ApiDraft>();
  const exchanges: HarRecordedExchange[] = [];
  const statuses: Record<string, number> = {};
  let preflights = 0;
  let statics = 0;
  let nonHttp = 0;
  let cookieRequests = 0;
  let kept = 0;

  for (const e of log.entries) {
    let url: URL;
    try {
      url = new URL(e.request.url);
    } catch {
      nonHttp += 1;
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      nonHttp += 1;
      continue;
    }
    if (isPreflight(e)) {
      preflights += 1;
      continue;
    }
    if (options.includeStaticAssets !== true && isStatic(e, url)) {
      statics += 1;
      continue;
    }
    kept += 1;
    const status = String(e.response.status);
    statuses[status] = (statuses[status] ?? 0) + 1;

    let draft = drafts.get(url.origin);
    if (draft === undefined) {
      draft = {
        id: newId(),
        name: url.host,
        origin: url.origin,
        order: firstOrder + drafts.size,
        requests: new Map(),
        examples: new Map(),
        slugs: new Set(),
      };
      drafts.set(url.origin, draft);
    }

    const method = e.request.method.toUpperCase();
    const label = `${method} ${url.pathname}`;
    const key = dedupeKey(method, url);
    let request = draft.requests.get(key);
    if (request === undefined) {
      const slug = uniqueSlug(label, draft.slugs);
      const blanked = new Set<string>();
      const query = e.request.queryString.map((q) => {
        if (!isSensitiveQueryParam(q.name) || q.value === '') return entry(q.name, q.value);
        blanked.add(q.name);
        return entry(q.name, '');
      });
      const body = mapPostData(e.request.postData, label, report, blanked);
      if (blanked.size > 0) {
        report.warn(
          `${label}: the recorded value of ${[...blanked].join(', ')} was not imported; set it on the request.`,
        );
      }
      request = createRestRequest(label, {
        newId,
        order: draft.requests.size,
        slug,
        method,
        url: url.pathname,
        query,
        headers: requestHeaders(e.request.headers, label, report).map((h) => entry(h.name, h.value)),
        body,
        auth: authFrom(e.request.headers, label, report),
      });
      draft.requests.set(key, request);
      draft.slugs.add(slug);
      if (e.request.headers.some((h) => h.name.toLowerCase() === 'cookie')) cookieRequests += 1;
    }

    if (responses === 'examples') {
      let examples = draft.examples.get(key);
      if (examples === undefined) {
        examples = new Map();
        draft.examples.set(key, examples);
      }
      if (!examples.has(e.response.status) && examples.size < MAX_EXAMPLES) {
        examples.set(e.response.status, exampleOf(e, newId(), label, report));
      }
    } else if (responses === 'history') {
      const responseBody = bodyText(e.response.content);
      exchanges.push({
        requestId: request.id,
        at: e.startedDateTime,
        durationMs: Math.round(e.time),
        method,
        url: e.request.url,
        requestHeaders: e.request.headers,
        requestBody: e.request.postData?.text ?? '',
        status: e.response.status,
        statusText: e.response.statusText,
        responseHeaders: e.response.headers,
        ...(responseBody !== undefined ? { responseBody } : {}),
      });
    }
  }

  if (preflights > 0)
    report.note(`${counted(preflights, 'CORS preflight request', 'CORS preflight requests')} skipped.`);
  if (statics > 0) {
    report.note(
      `${counted(statics, 'static asset', 'static assets')} skipped; tick "Include static assets" to import them.`,
    );
  }
  if (nonHttp > 0)
    report.note(`${counted(nonHttp, 'entry with a non-HTTP URL', 'entries with a non-HTTP URL')} skipped.`);
  if (cookieRequests > 0) {
    report.note(
      `Cookies were dropped from ${cookieRequests} request${cookieRequests === 1 ? '' : 's'}; the cookie jar handles them at send time.`,
    );
  }
  if (log.skippedMalformed > 0) {
    report.note(`${counted(log.skippedMalformed, 'malformed entry', 'malformed entries')} skipped.`);
  }

  const apis = [...drafts.values()].map((draft) =>
    createApi(draft.name, {
      id: draft.id,
      order: draft.order,
      baseUrl: draft.origin,
      servers: [{ url: draft.origin }],
      requests: [...draft.requests].map(([key, request]) => {
        const examples = draft.examples.get(key);
        return examples !== undefined && examples.size > 0 ? { ...request, examples: [...examples.values()] } : request;
      }),
    }),
  );
  exchanges.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    apis,
    exchanges,
    summary: {
      entries: log.entries.length + log.skippedMalformed,
      kept,
      requests: apis.reduce((total, api) => total + api.requests.length, 0),
      apis: apis.length,
      statuses,
    },
    report: report.build(),
  };
}
