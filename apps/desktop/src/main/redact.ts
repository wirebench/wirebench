/**
 * Masks secret-bearing values before they cross IPC into the renderer (HTTP log, and later
 * history — Task 24 reuses these helpers). The engine's own in-memory `HttpExchange` stays
 * unredacted; everything built for the wire (`engine-wire.ts`) goes through here unless the
 * session's "show secrets" flag is on.
 */

const REDACTED = '<redacted>';

/** The exact marker text every redaction helper below writes in place of a masked secret. */
export const REDACTED_MARKER = REDACTED;

/** True when `text` contains the redaction marker — i.e. it was produced by a `redact*` helper. */
export function containsRedaction(text: string): boolean {
  return text.includes(REDACTED_MARKER);
}

/** Header names (case-insensitive) whose value is always masked. */
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);

/** Masks the values of sensitive headers in a plain header map, case-insensitively. */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  opts?: { show?: boolean },
): Record<string, string> {
  if (opts?.show) {
    return { ...headers };
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return result;
}

/**
 * Masks the values of sensitive headers in a `[name, value]` pair list — the raw, duplicate-
 * preserving header form (`Set-Cookie` appears once per cookie there, so this list is exactly
 * where a naive copy leaks by default).
 */
export function redactHeaderPairs(
  pairs: readonly (readonly [string, string])[],
  opts?: { show?: boolean },
): [string, string][] {
  const show = opts?.show ?? false;
  return pairs.map(([name, value]) => [name, !show && SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value]);
}

/**
 * Query-parameter names (case-insensitive) whose value is masked wherever a URL is logged, stored
 * or shown. An API key that travels in the query string is as much a credential as one in a header,
 * and a URL reaches more places than a header does: the HTTP log, history, the cURL export, a
 * problem message.
 */
const SENSITIVE_QUERY_PARAMS = new Set([
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'token',
  'key',
  'auth',
  'signature',
  'sig',
]);

/**
 * Masks the value of every sensitive query parameter in `url`, plus any parameter named in
 * `extraParams` — which is how the send path masks the exact parameter an API key is configured to
 * travel in, whatever it is called.
 *
 * A URL that cannot be parsed is returned unchanged: it is already not a URL, and mangling it would
 * only hide what is wrong with it.
 */
export function redactUrl(url: string, opts?: { show?: boolean; extraParams?: readonly string[] }): string {
  if (opts?.show === true) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const extra = new Set((opts?.extraParams ?? []).map((name) => name.toLowerCase()));
  let changed = false;
  if (parsed.password !== '') {
    parsed.password = REDACTED;
    changed = true;
  }
  for (const name of [...parsed.searchParams.keys()]) {
    const lower = name.toLowerCase();
    if (SENSITIVE_QUERY_PARAMS.has(lower) || extra.has(lower)) {
      parsed.searchParams.set(name, REDACTED);
      changed = true;
    }
  }
  // `URL` normalises as it serialises (a `+` becomes `%2B`, a default port disappears), so an
  // untouched URL is returned as it came in rather than as the parser would have written it.
  return changed ? parsed.toString() : url;
}

/**
 * The redaction pass for a response's attachment list. Nothing in `{index, contentId,
 * contentType, size, name}` carries a secret today, so this is a copy — it exists as the one
 * call site so that when a part's `Content-Disposition` (or a signed-URL-shaped name) does need
 * masking, it is masked everywhere the list is built, including on a show-secrets re-render.
 * It takes no `show` flag: both callers (`toResponseAttachmentWires` and
 * `redactExchangeSummary`) decide for themselves whether to run it, because the summary built
 * with `{ show: true }` is the unredacted master the `ExchangeCache` keeps.
 */
export function redactResponseAttachments<T>(attachments: readonly T[]): T[] {
  return [...attachments];
}

/**
 * The start of an (optionally namespace-prefixed) `<Password` open tag, and a matching close tag.
 *
 * Used by a scanner rather than as one `/(<…Password[^>]*>)([\\s\\S]*?)(<\\/…Password>)/gi`: that
 * pattern's lazy body backtracks to the end of the text for every open tag that has no close tag,
 * which is O(n²) — and this runs over a *response*, so the text is whatever server answered.
 */
const PASSWORD_OPEN_RE = /<(?:[\w-]+:)?Password\b/gi;
const PASSWORD_CLOSE_RE = /<\/(?:[\w-]+:)?Password>/gi;

/** Matches a `Type` attribute in a `Password` open tag, capturing its value. */
const TYPE_ATTR_RE = /\bType\s*=\s*"([^"]*)"|\bType\s*=\s*'([^']*)'/i;

/**
 * Whether a `<Password>` open tag's `Type` attribute marks the value as a `#PasswordDigest` —
 * not a secret, and never masked. Any other `Type` (including the WSS `#PasswordText` profile
 * URI) or a missing `Type` attribute is treated as a plaintext password and masked.
 */
function isPasswordDigest(openTag: string): boolean {
  const match = TYPE_ATTR_RE.exec(openTag);
  const value = match?.[1] ?? match?.[2];
  return value !== undefined && value.endsWith('#PasswordDigest');
}

/**
 * Masks the text content of `wsse:Password` elements (any namespace prefix) in raw XML — except
 * a `#PasswordDigest` value, which is a hash, not a secret, and must reach the wire intact.
 */
export function redactXml(text: string, opts?: { show?: boolean }): string {
  if (opts?.show) {
    return text;
  }
  // One forward pass. Each open tag is paired with the first close tag after it (what the lazy
  // match did), and the scan resumes past that close tag. An open tag with no `>` or no close tag
  // ends the pass: nothing later could pair either, which is exactly when the regex found nothing.
  const open = new RegExp(PASSWORD_OPEN_RE.source, 'gi');
  const close = new RegExp(PASSWORD_CLOSE_RE.source, 'gi');
  let out = '';
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const opened = open.exec(text);
    if (opened === null) {
      break;
    }
    const tagEnd = text.indexOf('>', opened.index + opened[0].length);
    if (tagEnd === -1) {
      break;
    }
    close.lastIndex = tagEnd + 1;
    const closed = close.exec(text);
    if (closed === null) {
      break;
    }
    const openTag = text.slice(opened.index, tagEnd + 1);
    const content = isPasswordDigest(openTag) ? text.slice(tagEnd + 1, closed.index) : REDACTED;
    out += `${text.slice(from, tagEnd + 1)}${content}${closed[0]}`;
    from = closed.index + closed[0].length;
  }
  return out + text.slice(from);
}

/** Body keys whose values are masked in JSON and form bodies, compared case-insensitively. */
export const SECRET_BODY_KEYS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'api_key',
  'apikey',
  'authorization',
];
const SECRET_BODY_KEY_SET = new Set(SECRET_BODY_KEYS);

function mediaTypeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

function isJsonType(contentType: string): boolean {
  const type = mediaTypeOf(contentType);
  return type === 'application/json' || type.endsWith('+json');
}

function isFormType(contentType: string): boolean {
  return mediaTypeOf(contentType) === 'application/x-www-form-urlencoded';
}

/** A copy with every secret-keyed value replaced whole — a nested object or array under one too. */
function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        SECRET_BODY_KEY_SET.has(key.toLowerCase()) ? REDACTED : maskJson(inner),
      ]),
    );
  }
  return value;
}

/** The indentation of the input's second line, so a pretty body stays pretty and a compact one compact. */
function indentOf(text: string): number | undefined {
  const match = /\n( +)\S/.exec(text);
  return match?.[1]?.length;
}

function maskFormPair(pair: string): string {
  const eq = pair.indexOf('=');
  const rawKey = eq < 0 ? pair : pair.slice(0, eq);
  let key: string;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    key = rawKey;
  }
  return SECRET_BODY_KEY_SET.has(key.toLowerCase()) ? `${rawKey}=${encodeURIComponent(REDACTED)}` : pair;
}

/**
 * Masks secret-keyed values in a JSON (`application/json`, `+json`) or urlencoded form body;
 * anything else, or JSON that does not parse, is returned as is.
 */
export function redactStructuredBody(text: string, contentType: string | undefined, opts?: { show?: boolean }): string {
  if (opts?.show === true || contentType === undefined) {
    return text;
  }
  if (isJsonType(contentType)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    return JSON.stringify(maskJson(parsed), null, indentOf(text));
  }
  if (isFormType(contentType)) {
    return text.split('&').map(maskFormPair).join('&');
  }
  return text;
}

/** Masks a single raw `name: value` header line (no terminator), case-insensitively. */
function redactHeaderLine(line: string): string {
  const idx = line.indexOf(':');
  if (idx < 0) {
    return line;
  }
  const name = line.slice(0, idx).trim().toLowerCase();
  if (!SENSITIVE_HEADERS.has(name)) {
    return line;
  }
  return `${line.slice(0, idx + 1)} ${REDACTED}`;
}

/** Content types whose body is text we may safely decode, mask and re-encode. */
const TEXTUAL_CONTENT_TYPES = ['text/xml', 'application/soap+xml', 'application/xml', 'text/plain'];

/** Reads the (first) value of `name` out of an already-decoded header block. */
function headerValue(headerBlock: string, name: string): string | undefined {
  for (const line of headerBlock.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === name) {
      return line.slice(idx + 1).trim();
    }
  }
  return undefined;
}

/**
 * Whether the body bytes may be decoded as text and masked: only for a SOAP/XML/plain content
 * type, and never when a `content-encoding` says the bytes are compressed (decoding those as
 * text would corrupt them irrecoverably).
 */
function bodyIsIdentityEncoded(headerBlock: string): boolean {
  const encoding = headerValue(headerBlock, 'content-encoding');
  return encoding === undefined || encoding.length === 0 || encoding.toLowerCase() === 'identity';
}

function bodyIsMaskableText(headerBlock: string): boolean {
  if (!bodyIsIdentityEncoded(headerBlock)) {
    return false;
  }
  const contentType = headerValue(headerBlock, 'content-type')?.toLowerCase() ?? '';
  return TEXTUAL_CONTENT_TYPES.some((type) => contentType.startsWith(type));
}

/**
 * Redacts a raw HTTP message **on its bytes**, never assuming the whole message is UTF-8 text.
 *
 * The buffer is split at the first `\r\n\r\n` (falling back to `\n\n`); only the header block is
 * decoded — as latin1, which is byte-preserving for the ASCII header grammar — so sensitive
 * header lines can be masked while their original line terminators are re-joined verbatim. The
 * body is decoded and masked (`wsse:Password`) only when the headers say it is uncompressed
 * SOAP/XML/plain text; otherwise its bytes are copied through untouched, so a gzip or binary
 * body round-trips byte-identically.
 *
 * `opts.encoding` says whether `input`/the return value is `'text'` (default) or a `'base64'`
 * string, so callers can pass the wire's `rawRequestBase64`/`rawResponseBase64` straight through.
 */
export function redactRawHttp(input: string, opts?: { show?: boolean; encoding?: 'text' | 'base64' }): string {
  if (opts?.show) {
    return input;
  }
  const isBase64 = opts?.encoding === 'base64';
  const buffer = isBase64 ? Buffer.from(input, 'base64') : Buffer.from(input, 'utf8');

  let separator = '\r\n\r\n';
  let splitIndex = buffer.indexOf(separator);
  if (splitIndex < 0) {
    separator = '\n\n';
    splitIndex = buffer.indexOf(separator);
  }
  const headerEnd = splitIndex >= 0 ? splitIndex : buffer.length;
  const headerBlock = buffer.subarray(0, headerEnd).toString('latin1');
  const bodyBytes = splitIndex >= 0 ? buffer.subarray(headerEnd + separator.length) : Buffer.alloc(0);

  // Split keeping the terminators so `\r\n` and `\n` mixes survive the round trip verbatim.
  const redactedHeaderBlock = headerBlock
    .split(/(\r\n|\n)/)
    .map((part, index) => (index % 2 === 0 ? redactHeaderLine(part) : part))
    .join('');

  // XML first (a `wsse:Password` element), then JSON and form bodies by key. A compressed body is
  // left alone: its bytes are not the text either pass reads.
  let bodyText = bodyIsMaskableText(headerBlock) ? redactXml(bodyBytes.toString('utf8')) : undefined;
  const contentType = headerValue(headerBlock, 'content-type');
  if (contentType !== undefined && bodyIsIdentityEncoded(headerBlock)) {
    const before = bodyText ?? bodyBytes.toString('utf8');
    const structured = redactStructuredBody(before, contentType);
    if (structured !== before) {
      bodyText = structured;
    }
  }
  const redactedBody = bodyText === undefined ? bodyBytes : Buffer.from(bodyText, 'utf8');

  const parts = [Buffer.from(redactedHeaderBlock, 'latin1')];
  if (splitIndex >= 0) {
    parts.push(Buffer.from(separator, 'latin1'), redactedBody);
  }
  const out = Buffer.concat(parts);

  return isBase64 ? out.toString('base64') : out.toString('utf8');
}
