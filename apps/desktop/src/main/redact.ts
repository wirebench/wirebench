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

/** Masks a single raw `name: value\r\n` header line, case-insensitively. */
function redactHeaderLine(line: string, show: boolean): string {
  if (show) {
    return line;
  }
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

/**
 * Redacts a raw HTTP message: the header block (start-line + `name: value` lines up to the first
 * blank line) and, within the body, any `wsse:Password` text. `opts.encoding` says whether
 * `input`/the return value is `'text'` (default) or a `'base64'` string, so callers can pass the
 * wire's `rawRequestBase64`/`rawResponseBase64` straight through without decoding themselves.
 */
export function redactRawHttp(input: string, opts?: { show?: boolean; encoding?: 'text' | 'base64' }): string {
  if (opts?.show) {
    return input;
  }
  const show = false;
  const isBase64 = opts?.encoding === 'base64';
  const text = isBase64 ? Buffer.from(input, 'base64').toString('utf8') : input;

  const splitIndex = text.search(/\r?\n\r?\n/);
  const headerPart = splitIndex >= 0 ? text.slice(0, splitIndex) : text;
  const rest = splitIndex >= 0 ? text.slice(splitIndex) : '';

  const redactedHeaderPart = headerPart
    .split(/\r?\n/)
    .map((line) => redactHeaderLine(line, show))
    .join('\n');
  const redactedBody = redactXml(rest, { show });
  const redacted = `${redactedHeaderPart}${redactedBody}`;

  return isBase64 ? Buffer.from(redacted, 'utf8').toString('base64') : redacted;
}
