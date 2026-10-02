/**
 * What a script sees of a REST request and its response (spec §3.4): the snapshots, the converters
 * between a prepared send and a snapshot, the API's declarations, its sandbox-side source, and what
 * the script rules check.
 */
import { z } from 'zod';
import type { ProtocolScripting, SnapshotFacts } from '../protocol/module.js';
import { headerPairSchema } from '../script/apply.js';
import type { HeaderPair, ScriptFailure } from '../script/model.js';
import { entriesOf, pairsOf } from '../script/send.js';
import type { RawLanguage } from './model.js';
import type { RestExchange, RestSendInput } from './send.js';
import { composeUrl } from './url.js';

/** A REST request body as a script sees it: text it can read and replace, or a kind it cannot edit. */
export type RestBodySnapshot =
  | { readonly kind: 'none' }
  | { readonly kind: 'text'; readonly text: string; readonly language: string }
  /** A form, multipart or binary body: kept as it is, and not editable from a script. */
  | { readonly kind: 'other'; readonly description: string };

export interface RestRequestSnapshot {
  readonly protocol: 'rest';
  readonly method: string;
  /** The full URL, query included, as it will be sent. */
  readonly url: string;
  readonly headers: readonly HeaderPair[];
  readonly body: RestBodySnapshot;
}

export interface RestResponseSnapshot {
  readonly protocol: 'rest';
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderPair[];
  readonly text: string;
  readonly durationMs: number;
}

const RAW_LANGUAGES: readonly RawLanguage[] = ['json', 'xml', 'text', 'html', 'javascript'];

export function restRequestSnapshot(input: RestSendInput): RestRequestSnapshot {
  const { request } = input;
  const url = composeUrl(input.baseUrl, request.url, request.pathParams, request.query, {
    encode: input.settings.encodeUrl ?? true,
  }).url;
  let body: RestBodySnapshot;
  switch (request.body.kind) {
    case 'none':
      body = { kind: 'none' };
      break;
    case 'raw':
      body = { kind: 'text', text: request.body.text, language: request.body.language };
      break;
    default:
      body = { kind: 'other', description: `a ${request.body.kind} body` };
  }
  return { protocol: 'rest', method: request.method, url, headers: pairsOf(request.headers), body };
}

/** The send with a pre-request script's changes. The URL is rebuilt only when the script changed it. */
export function applyRestSnapshot(
  input: RestSendInput,
  before: RestRequestSnapshot,
  after: RestRequestSnapshot,
): RestSendInput {
  const urlChanged = after.url !== before.url;
  const body = ((): RestSendInput['request']['body'] => {
    if (after.body.kind === 'other' || JSON.stringify(after.body) === JSON.stringify(before.body)) {
      return input.request.body;
    }
    if (after.body.kind === 'none') return { kind: 'none' };
    const language = (RAW_LANGUAGES as readonly string[]).includes(after.body.language)
      ? (after.body.language as RawLanguage)
      : 'text';
    const was = input.request.body;
    return {
      kind: 'raw',
      language,
      ...(was.kind === 'raw' && was.contentType !== undefined ? { contentType: was.contentType } : {}),
      text: after.body.text,
    };
  })();
  return {
    ...input,
    // A changed URL is sent exactly as the script wrote it: the script's query API has already
    // encoded what it added, so the send must not encode it again.
    ...(urlChanged ? { baseUrl: '', settings: { ...input.settings, encodeUrl: false } } : {}),
    request: {
      ...input.request,
      method: after.method,
      ...(urlChanged ? { url: after.url, pathParams: [], query: [] } : {}),
      headers: entriesOf(after.headers),
      body,
    },
  };
}

export function restResponseSnapshot(exchange: RestExchange): RestResponseSnapshot {
  return {
    protocol: 'rest',
    status: exchange.status,
    statusText: exchange.statusText,
    headers: exchange.rawHeaders.map(([n, v]) => [n, v] as const),
    text: exchange.text,
    durationMs: exchange.durationMs,
  };
}

const range = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join(' | ');

/** Every HTTP status a response can have, as literals, so an arm's status narrows exactly. */
const STATUS_TYPES = `
/** Any HTTP status, as literals, so that checking \`response.status\` narrows the response. */
type WbStatus = ${range(100, 599)};
type WbRange1 = Extract<WbStatus, ${range(100, 199)}>;
type WbRange2 = Extract<WbStatus, ${range(200, 299)}>;
type WbRange3 = Extract<WbStatus, ${range(300, 399)}>;
type WbRange4 = Extract<WbStatus, ${range(400, 499)}>;
type WbRange5 = Extract<WbStatus, ${range(500, 599)}>;
`;

const REST_REQUEST = `
interface WbRestQuery {
  get(name: string): string | undefined;
  getAll(name: string): string[];
  list(): { name: string; value: string }[];
}
interface WbWritableRestQuery extends WbRestQuery {
  set(name: string, value: string): void;
  add(name: string, value: string): void;
  delete(name: string): void;
}
interface WbRestBody {
  /** \`other\` is a form, multipart or binary body, which a script cannot read or change. */
  readonly kind: 'none' | 'text' | 'other';
  readonly text: string;
  readonly json: WbRequestBody;
}
interface WbResponseArm<S extends number, B> {
  readonly status: S;
  readonly statusText: string;
  readonly headers: WbPairs;
  readonly text: string;
  /** The body parsed as JSON, typed from the contract's response for this status. */
  json(): B;
  readonly durationMs: number;
}
interface WbWritableRestBody {
  readonly kind: 'none' | 'text' | 'other';
  text: string;
  json: WbRequestBody;
}
`;

const REST_PRE = `
declare const request: {
  method: string;
  /** The full URL. A script may change the path, query and fragment, never the scheme, host or port. */
  url: string;
  readonly query: WbWritableRestQuery;
  readonly headers: WbWritablePairs;
  readonly body: WbWritableRestBody;
};
`;

const REST_POST = `
declare const request: {
  readonly method: string;
  readonly url: string;
  readonly query: WbRestQuery;
  readonly headers: WbPairs;
  readonly body: WbRestBody;
};
declare const response: WbResponse;
`;

/** Splits and joins a URL's query without a URL class, which QuickJS lacks. */
const REST = String.raw`
const splitUrl = (url) => {
  const hashAt = url.indexOf('#');
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  return {
    base: queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt),
    query: queryAt === -1 ? '' : beforeHash.slice(queryAt + 1),
    fragment,
  };
};
const decode = (text) => { try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; } };
const encode = (text) => encodeURIComponent(text);

const restRequest = (snapshot, writable) => {
  const data = {
    method: snapshot.method,
    url: snapshot.url,
    headers: snapshot.headers.map(([n, v]) => [n, v]),
    body: JSON.parse(JSON.stringify(snapshot.body)),
  };
  const queryPairs = () => {
    const { query } = splitUrl(data.url);
    return query === '' ? [] : query.split('&').filter((p) => p !== '').map((part) => {
      const eq = part.indexOf('=');
      return eq === -1 ? [decode(part), ''] : [decode(part.slice(0, eq)), decode(part.slice(eq + 1))];
    });
  };
  const writeQuery = (pairs) => {
    const { base, fragment } = splitUrl(data.url);
    const query = pairs.map(([n, v]) => encode(n) + '=' + encode(v)).join('&');
    data.url = base + (query === '' ? '' : '?' + query) + fragment;
  };
  const refuse = (what) => () => { throw new TypeError('The ' + what + ' of a sent request cannot be changed'); };
  const query = Object.freeze({
    get: (name) => { const hit = queryPairs().find(([n]) => n === String(name)); return hit === undefined ? undefined : hit[1]; },
    getAll: (name) => queryPairs().filter(([n]) => n === String(name)).map(([, v]) => v),
    list: () => queryPairs().map(([name, value]) => ({ name, value })),
    set: writable ? (name, value) => {
      const pairs = queryPairs().filter(([n]) => n !== String(name));
      pairs.push([String(name), String(value)]);
      writeQuery(pairs);
    } : refuse('query'),
    add: writable ? (name, value) => { const pairs = queryPairs(); pairs.push([String(name), String(value)]); writeQuery(pairs); } : refuse('query'),
    delete: writable ? (name) => writeQuery(queryPairs().filter(([n]) => n !== String(name))) : refuse('query'),
  });
  const headers = pairsApi(data.headers, writable, 'header');
  const bodyText = () => {
    if (data.body.kind === 'text') return data.body.text;
    if (data.body.kind === 'none') return '';
    throw new TypeError('This request\'s body is ' + data.body.description + ', which a script cannot read or change');
  };
  const body = Object.freeze({
    get kind() { return data.body.kind === 'other' ? 'other' : data.body.kind; },
    get text() { return bodyText(); },
    set text(value) {
      if (!writable) refuse('body')();
      if (data.body.kind === 'other') bodyText();
      data.body = { kind: 'text', text: String(value), language: data.body.kind === 'text' ? data.body.language : 'text' };
    },
    get json() { return JSON.parse(bodyText()); },
    set json(value) {
      if (!writable) refuse('body')();
      if (data.body.kind === 'other') bodyText();
      const text = JSON.stringify(value);
      if (text === undefined) throw new TypeError('body.json must be a JSON value');
      data.body = { kind: 'text', text, language: 'json' };
    },
  });
  const request = Object.freeze({
    get method() { return data.method; },
    set method(value) { if (!writable) refuse('method')(); data.method = String(value).toUpperCase(); },
    get url() { return data.url; },
    set url(value) { if (!writable) refuse('URL')(); data.url = String(value); },
    query,
    headers,
    body,
  });
  const snapshotOf = () => ({ protocol: 'rest', method: data.method, url: data.url, headers: data.headers, body: data.body });
  return { request, snapshotOf };
};

const restResponse = (snapshot) => deepFreeze({
  status: snapshot.status,
  statusText: snapshot.statusText,
  headers: pairsApi(snapshot.headers.map(([n, v]) => [n, v]), false, 'header'),
  text: snapshot.text,
  json: () => JSON.parse(snapshot.text),
  durationMs: snapshot.durationMs,
});

if (input.phase === 'pre') {
  const built = restRequest(input.request, true);
  define('request', built.request);
  state.request = built.snapshotOf;
} else {
  define('request', restRequest(input.request, false).request);
  define('response', restResponse(input.response));
}
`;

/** An HTTP method token. The generic rules do not know what a method is, so this one is REST's own. */
const METHOD = /^[A-Z][A-Z0-9_-]{0,31}$/;

const bodySchema: z.ZodType<RestBodySnapshot> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('text'), text: z.string(), language: z.string() }),
  z.object({ kind: z.literal('other'), description: z.string() }),
]);

const requestSchema: z.ZodType<RestRequestSnapshot> = z.object({
  protocol: z.literal('rest'),
  method: z.string(),
  url: z.string(),
  headers: z.array(headerPairSchema),
  body: bodySchema,
});

/** REST's scripting facet. */
export const restScripting: ProtocolScripting<RestRequestSnapshot, RestResponseSnapshot> = {
  declarations: (phase) => [STATUS_TYPES, REST_REQUEST, phase === 'pre' ? REST_PRE : REST_POST].join('\n'),
  reference: () => [
    { title: 'REST: shared by both phases', declarations: REST_REQUEST },
    { title: 'REST: pre-request', declarations: REST_PRE },
    { title: 'REST: post-response', declarations: REST_POST },
  ],
  prelude: () => REST,
  requestSchema,
  inspect(snapshot): SnapshotFacts {
    return {
      destination: snapshot.url,
      // A form, multipart or binary body comes back exactly as it went; a text body is the script's.
      fixed: snapshot.body.kind === 'other' ? snapshot.body : null,
      pairs: snapshot.headers,
      lines: [snapshot.url],
      texts: [
        snapshot.method,
        snapshot.url,
        ...snapshot.headers.flat(),
        ...(snapshot.body.kind === 'text' ? [snapshot.body.text] : []),
      ],
    };
  },
  validate(_before, after): ScriptFailure | undefined {
    return METHOD.test(after.method)
      ? undefined
      : { code: 'script-value-invalid', message: `"${after.method}" is not an HTTP method` };
  },
};
