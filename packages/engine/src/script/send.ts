/**
 * Between a prepared send and the script API (spec §What a pre-request script can change, §Secrets).
 *
 * A request with scripts is prepared with every `${secret:…}` in its text replaced by an
 * unguessable placeholder, so a script sees neither the value nor text it could turn into a
 * reference. After the script, the host puts each placeholder back as the secret's value — secrets
 * are substituted raw by every expander, so the value lands exactly as it would have. A placeholder
 * is alphanumeric, so no escaping along the way changes it, and a value a server chose can never
 * name one: the nonce is new for every send.
 *
 * The converters turn a prepared send into the snapshot a script sees and a changed snapshot back
 * into a send. What a script cannot see — configured auth, TLS, the proxy — stays on the send as it
 * was.
 */
import { randomUUID } from 'node:crypto';
import type { GrpcCallResult } from '../grpc/call.js';
import type { GrpcSendInput } from '../grpc/send.js';
import type { KeyValueEntry, RawLanguage } from '../rest/model.js';
import type { RestExchange, RestSendInput } from '../rest/send.js';
import { composeUrl } from '../rest/url.js';
import { resolveSecretTokens, type GetSecret } from '../secrets/resolve.js';
import type { SoapExchange, SoapSendInput } from '../types.js';
import type {
  GrpcRequestSnapshot,
  GrpcResponseSnapshot,
  HeaderPair,
  RestBodySnapshot,
  RestRequestSnapshot,
  RestResponseSnapshot,
  SoapRequestSnapshot,
  SoapResponseSnapshot,
} from './model.js';

/** The placeholders one send's secrets stand behind until its pre-request script has run. */
export class SecretPlaceholders {
  private readonly nonce = randomUUID().replace(/-/g, '');
  private readonly byName = new Map<string, string>();

  /** The placeholder for `name`, the same one every time within this send. */
  placeholderFor(name: string): string {
    let placeholder = this.byName.get(name);
    if (placeholder === undefined) {
      placeholder = `wbsec${this.nonce}n${String(this.byName.size)}z`;
      this.byName.set(name, placeholder);
    }
    return placeholder;
  }

  /** A `secrets` scope that maps each name to its placeholder, for the given names. */
  scopeFor(names: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of names) out[name] = this.placeholderFor(name);
    return out;
  }

  get size(): number {
    return this.byName.size;
  }

  /**
   * `value` with every placeholder replaced by its secret's value, in every string it holds.
   *
   * @throws WirebenchError `secret-missing` when a secret cannot be read
   */
  async restore<T>(value: T, getSecret: GetSecret): Promise<T> {
    if (this.byName.size === 0) return value;
    const secrets = await resolveSecretTokens(this.byName.keys(), getSecret);
    const replacements = new Map([...this.byName].map(([name, placeholder]) => [placeholder, secrets[name] ?? '']));
    const pattern = new RegExp([...replacements.keys()].join('|'), 'g');
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') return node.replace(pattern, (hit) => replacements.get(hit) ?? hit);
      if (Array.isArray(node)) return node.map(walk);
      if (node !== null && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
      }
      return node;
    };
    return walk(value) as T;
  }
}

const pairsOf = (entries: readonly KeyValueEntry[]): HeaderPair[] =>
  entries.filter((e) => e.enabled).map((e) => [e.name, e.value] as const);

const entriesOf = (pairs: readonly HeaderPair[]): KeyValueEntry[] =>
  pairs.map(([name, value]) => ({ name, value, enabled: true }));

const recordPairs = (record: Readonly<Record<string, string>> | undefined): HeaderPair[] =>
  Object.entries(record ?? {}).map(([name, value]) => [name, value] as const);

const RAW_LANGUAGES: readonly RawLanguage[] = ['json', 'xml', 'text', 'html', 'javascript'];

// --- REST ---------------------------------------------------------------------------------------

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

// --- SOAP ---------------------------------------------------------------------------------------

/** A SOAP send already expanded (with placeholders), as a script sees it. */
export function soapRequestSnapshot(expanded: SoapSendInput): SoapRequestSnapshot {
  return {
    protocol: 'soap',
    endpoint: expanded.endpoint,
    soapAction: expanded.soapAction ?? '',
    headers: recordPairs(expanded.headers),
    envelope: expanded.envelopeXml,
  };
}

/** The expanded send with a pre-request script's changes; a header set twice keeps its last value. */
export function applySoapSnapshot(expanded: SoapSendInput, after: SoapRequestSnapshot): SoapSendInput {
  return {
    ...expanded,
    endpoint: after.endpoint,
    ...(after.soapAction !== '' || expanded.soapAction !== undefined ? { soapAction: after.soapAction } : {}),
    headers: Object.fromEntries(after.headers.map(([n, v]) => [n, v])),
    envelopeXml: after.envelope,
  };
}

export function soapResponseSnapshot(exchange: SoapExchange): SoapResponseSnapshot {
  const fault = exchange.response?.fault;
  return {
    protocol: 'soap',
    status: exchange.http.status,
    headers: exchange.http.rawHeaders.map(([n, v]) => [n, v] as const),
    text: exchange.response?.envelopeXml ?? new TextDecoder().decode(exchange.http.body),
    durationMs: exchange.durationMs,
    ...(fault !== undefined ? { fault: { code: fault.code, reason: fault.reason } } : {}),
  };
}

// --- gRPC ---------------------------------------------------------------------------------------

type PreparedGrpc = Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;

export function grpcRequestSnapshot(input: PreparedGrpc, messageText: string): GrpcRequestSnapshot {
  let message: unknown;
  try {
    message = JSON.parse(messageText);
  } catch {
    message = messageText;
  }
  return {
    protocol: 'grpc',
    target: input.target,
    method: `${input.service}/${input.method}`,
    metadata: pairsOf(input.metadata),
    message,
  };
}

export function applyGrpcSnapshot(
  input: PreparedGrpc,
  messageText: string,
  before: GrpcRequestSnapshot,
  after: GrpcRequestSnapshot,
): { input: PreparedGrpc; messageText: string } {
  const changed = JSON.stringify(after.message) !== JSON.stringify(before.message);
  return {
    input: { ...input, metadata: entriesOf(after.metadata) },
    messageText: changed ? JSON.stringify(after.message, null, 2) : messageText,
  };
}

export function grpcResponseSnapshot(result: GrpcCallResult): GrpcResponseSnapshot {
  const first = result.responseMessages[0];
  return {
    protocol: 'grpc',
    status: {
      code: result.exchange.status,
      name: result.exchange.statusName,
      message: result.exchange.statusMessage ?? '',
    },
    metadata: recordPairs(result.exchange.headers),
    trailers: recordPairs(result.exchange.trailers),
    message: first?.json,
    durationMs: result.exchange.durationMs,
  };
}
