/**
 * AWS Signature Version 4: the canonical request, the string to sign, the signing key and what they
 * put on a request — an `Authorization` header, or a presigned query string.
 *
 * Pure: the caller passes the time and the request exactly as it goes on the wire (`sendWithAuth`
 * passes the URL as the transport serializes it). The path is read from the URL string as written,
 * not re-parsed, because S3 signs it verbatim, dot segments and all, while every other service signs
 * it percent-encoded a second time.
 */

import { createHash, createHmac } from 'node:crypto';

/** The credentials one signature needs, already resolved to values. */
export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Temporary credentials' token, signed as `X-Amz-Security-Token`. */
  readonly sessionToken?: string;
  readonly region: string;
  readonly service: string;
}

/** The parts of a request a signature covers. */
export interface SigV4Request {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

/** How to sign. */
export interface SigV4Options {
  /** Milliseconds since the epoch: the signature's date. */
  readonly now: number;
  /** `header` (the default) adds `Authorization`; `query` presigns the URL. */
  readonly placement?: 'header' | 'query';
  /** How long a presigned URL is valid, in seconds. Default 900. */
  readonly expiresSeconds?: number;
  /**
   * Which of the request's own headers to sign, by lower-cased name. `host` and the headers the
   * signature adds are always signed. Defaults to {@link isSignedByDefault}; the test suite signs all.
   */
  readonly signHeader?: (name: string) => boolean;
}

/** What a signature adds, and how it was made. */
export interface SigV4Signature {
  /** The URL to send: unchanged for a header signature, with the `X-Amz-*` parameters when presigned. */
  readonly url: string;
  /** Headers to add to the request; empty when presigned. */
  readonly headers: Readonly<Record<string, string>>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** The default lifetime of a presigned URL, and the longest AWS accepts. */
export const DEFAULT_EXPIRES_SECONDS = 900;
export const MAX_EXPIRES_SECONDS = 604_800;

/**
 * The request headers signed unless told otherwise: the ones a proxy or the transport will not
 * rewrite. `User-Agent`, `Accept-Encoding` or `Connection` may change on the way, which would break
 * a signature that covered them.
 */
export function isSignedByDefault(name: string): boolean {
  return name === 'content-type' || name === 'content-md5' || name === 'range' || name.startsWith('x-amz-');
}

/** The names of `headers` signed by default, lower-cased and sorted; `host` is always signed besides. */
export function sigV4SignedHeaderNames(headers: Readonly<Record<string, string>>): string[] {
  return [...new Set(Object.keys(headers).map((name) => name.toLowerCase()))].filter(isSignedByDefault).sort();
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 encoding: everything but the unreserved characters, upper-case hex. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Percent-decoding that leaves a malformed escape as written rather than failing the signature. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `YYYYMMDDTHHMMSSZ`. */
function amzDate(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** The URL's path and query as written, and its host. */
function splitUrl(url: string): { readonly host: string; readonly path: string; readonly query: string } {
  const parsed = new URL(url);
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)(?:\?([^#]*))?/.exec(url);
  const path = match?.[1] ?? '';
  return { host: parsed.host, path: path === '' ? '/' : path, query: match?.[2] ?? '' };
}

/** Removes `.` and `..` segments, as every service but S3 expects. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  const normalized = joined.startsWith('/') ? joined : `/${joined}`;
  return path.endsWith('/') && !normalized.endsWith('/') ? `${normalized}/` : normalized;
}

function canonicalPath(path: string, service: string): string {
  if (service === 's3') return path;
  return normalizePath(path)
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

/** `name=value` pairs, each encoded per RFC 3986, sorted by name and then value. */
function canonicalQuery(pairs: readonly (readonly [string, string])[]): string {
  return pairs
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** A query string's pairs, each decoded once; `+` stays a plus, as AWS reads it. */
function queryPairs(query: string): [string, string][] {
  return query
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const at = part.indexOf('=');
      return at === -1 ? [decode(part), ''] : [decode(part.slice(0, at)), decode(part.slice(at + 1))];
    });
}

/** A header value as signed: trimmed, with runs of white space collapsed. */
function canonicalValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** The signing key: the HMAC chain over the date, the region, the service and `aws4_request`. */
function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/**
 * Signs `request`.
 *
 * A header signature adds `X-Amz-Date`, `X-Amz-Security-Token` with a session token,
 * `X-Amz-Content-Sha256` for S3, and `Authorization`. A presigned one leaves the headers alone and
 * appends the `X-Amz-*` parameters to the URL; an S3 one signs `UNSIGNED-PAYLOAD`, as S3 defines that
 * form. Every other signature covers the SHA-256 of the body.
 */
export function signSigV4(request: SigV4Request, credentials: SigV4Credentials, options: SigV4Options): SigV4Signature {
  const placement = options.placement ?? 'header';
  const signHeader = options.signHeader ?? isSignedByDefault;
  const datetime = amzDate(options.now);
  const date = datetime.slice(0, 8);
  const scope = `${date}/${credentials.region}/${credentials.service}/aws4_request`;
  const { host, path, query } = splitUrl(request.url);
  const s3 = credentials.service === 's3';
  const payloadHash = placement === 'query' && s3 ? UNSIGNED_PAYLOAD : sha256Hex(request.body ?? new Uint8Array());

  const signed = new Map<string, string[]>();
  const add = (name: string, value: string): void => {
    const key = name.toLowerCase();
    signed.set(key, [...(signed.get(key) ?? []), canonicalValue(value)]);
  };
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (key === 'host' || signHeader(key)) add(name, value);
  }
  if (!signed.has('host')) add('host', host);

  const added: Record<string, string> = {};
  if (placement === 'header') {
    added['X-Amz-Date'] = datetime;
    if (credentials.sessionToken !== undefined) added['X-Amz-Security-Token'] = credentials.sessionToken;
    if (s3) added['X-Amz-Content-Sha256'] = payloadHash;
    for (const [name, value] of Object.entries(added)) {
      signed.delete(name.toLowerCase());
      add(name, value);
    }
  }
  const signedNames = [...signed.keys()].sort();
  const signedHeaders = signedNames.join(';');
  const presign: [string, string][] =
    placement === 'query'
      ? [
          ['X-Amz-Algorithm', ALGORITHM],
          ['X-Amz-Credential', `${credentials.accessKeyId}/${scope}`],
          ['X-Amz-Date', datetime],
          ['X-Amz-Expires', String(options.expiresSeconds ?? DEFAULT_EXPIRES_SECONDS)],
          ...(credentials.sessionToken !== undefined
            ? [['X-Amz-Security-Token', credentials.sessionToken] as [string, string]]
            : []),
          ['X-Amz-SignedHeaders', signedHeaders],
        ]
      : [];

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(path, credentials.service),
    canonicalQuery([...queryPairs(query), ...presign]),
    ...signedNames.map((name) => `${name}:${(signed.get(name) ?? []).join(',')}`),
    '',
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [ALGORITHM, datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(credentials.secretAccessKey, date, credentials.region, credentials.service),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');

  if (placement === 'query') {
    const appended = [...presign, ['X-Amz-Signature', signature] as const]
      .map(([name, value]) => `${name}=${uriEncode(value)}`)
      .join('&');
    const [base, fragment] = splitFragment(request.url);
    const separator = !base.includes('?') ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
    return { url: `${base}${separator}${appended}${fragment}`, headers: {}, canonicalRequest, stringToSign };
  }
  return {
    url: request.url,
    headers: {
      ...added,
      Authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
  };
}

function splitFragment(url: string): [string, string] {
  const at = url.indexOf('#');
  return at === -1 ? [url, ''] : [url.slice(0, at), url.slice(at)];
}
