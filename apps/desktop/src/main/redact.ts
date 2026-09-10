/**
 * Masks secret-bearing values before they cross IPC into the renderer (HTTP log, and later
 * history — Task 24 reuses these helpers). The engine's own in-memory `HttpExchange` stays
 * unredacted; everything built for the wire (`engine-wire.ts`) goes through here unless the
 * session's "show secrets" flag is on.
 */

const REDACTED = '<redacted>';

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

/** Matches an (optionally namespace-prefixed) `<Password ...>...</Password>` element's text. */
const WSSE_PASSWORD_RE = /(<(?:[\w-]+:)?Password\b[^>]*>)([\s\S]*?)(<\/(?:[\w-]+:)?Password>)/gi;

/** Masks the text content of `wsse:Password` elements (any namespace prefix) in raw XML. */
export function redactXml(text: string, opts?: { show?: boolean }): string {
  if (opts?.show) {
    return text;
  }
  return text.replace(
    WSSE_PASSWORD_RE,
    (_match, open: string, _content: string, close: string) => `${open}${REDACTED}${close}`,
  );
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
function bodyIsMaskableText(headerBlock: string): boolean {
  const encoding = headerValue(headerBlock, 'content-encoding');
  if (encoding !== undefined && encoding.length > 0 && encoding.toLowerCase() !== 'identity') {
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

  const redactedBody = bodyIsMaskableText(headerBlock)
    ? Buffer.from(redactXml(bodyBytes.toString('utf8')), 'utf8')
    : bodyBytes;

  const parts = [Buffer.from(redactedHeaderBlock, 'latin1')];
  if (splitIndex >= 0) {
    parts.push(Buffer.from(separator, 'latin1'), redactedBody);
  }
  const out = Buffer.concat(parts);

  return isBase64 ? out.toString('base64') : out.toString('utf8');
}
