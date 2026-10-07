/**
 * Masks secret-bearing values before they cross IPC into the renderer (HTTP log, and later
 * history — Task 24 reuses these helpers). The engine's own in-memory `HttpExchange` stays
 * unredacted; everything built for the wire (`engine-wire.ts`) goes through here unless the
 * session's "show secrets" flag is on.
 */

const REDACTED = '<redacted>';

/** The exact marker text every redaction helper below writes in place of a masked secret. */
export const REDACTED_MARKER = REDACTED;

/**
 * The marker as XML text, `&lt;redacted&gt;`: what {@link redactXml} writes, and what a masked XML
 * example holds, so a redacted XML document stays well formed and still reads as the marker.
 */
export const REDACTED_XML_MARKER = '&lt;redacted&gt;';

interface XmlTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Offset just past the `>`. */
  readonly end: number;
}

const NAME_CHAR = /[\w.:-]/;

/**
 * The tag that starts at `from` (a `<`), or undefined when none does: no name follows, or the tag is
 * cut by a `<` or by the end of the text. A quoted attribute value may hold `<` and `>`; an
 * unterminated quote runs to the end of the text.
 */
function tagAt(xml: string, from: number): XmlTag | undefined {
  let i = from + 1;
  const closing = xml[i] === '/';
  if (closing) {
    i += 1;
  }
  const nameStart = i;
  while (i < xml.length && NAME_CHAR.test(xml[i] ?? '')) {
    i += 1;
  }
  if (i === nameStart) {
    return undefined;
  }
  const name = xml.slice(nameStart, i);
  while (i < xml.length) {
    const char = xml[i];
    if (char === '"' || char === "'") {
      const close = xml.indexOf(char, i + 1);
      if (close === -1) {
        return undefined;
      }
      i = close + 1;
    } else if (char === '<') {
      return undefined;
    } else if (char === '>') {
      return { name, closing, selfClosing: xml[i - 1] === '/', end: i + 1 };
    } else {
      i += 1;
    }
  }
  return undefined;
}

/**
 * `xml` with every raw `<redacted>` that stands as text, wholly or as part of an element's content
 * (`<Auth>Bearer <redacted></Auth>`), written as {@link REDACTED_XML_MARKER}, so the document parses.
 * For History written before the masks wrote the escaped marker; a mask writes it escaped itself now.
 *
 * A raw marker reads as an open tag of an element named `redacted`; it is the message's own element
 * only when a `</redacted>` closes it, so one that another end tag closes first, or that is never
 * closed, is the marker. That is a limit: a message's own `<redacted>` element that holds a marker
 * (`<redacted>a <redacted></redacted>`) cannot be told from the marker. Comments, CDATA, processing
 * instructions and attribute values are left as they are.
 *
 * One pass: each step moves forward, and an unterminated comment, CDATA section, processing
 * instruction or tag ends the scan, so the cost is linear in the text however hostile.
 */
export function escapeStrayRedactionMarkers(xml: string): string {
  if (!xml.includes(REDACTED)) {
    return xml;
  }
  const stack: { name: string; start: number; end: number }[] = [];
  const strays: number[] = [];
  let i = xml.indexOf('<');
  while (i !== -1) {
    let next: number;
    if (xml.startsWith('<!--', i)) {
      next = xml.indexOf('-->', i + 4);
      next = next === -1 ? -1 : next + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      next = xml.indexOf(']]>', i + 9);
      next = next === -1 ? -1 : next + 3;
    } else if (xml.startsWith('<?', i)) {
      next = xml.indexOf('?>', i + 2);
      next = next === -1 ? -1 : next + 2;
    } else {
      const tag = tagAt(xml, i);
      if (tag === undefined) {
        next = i + 1;
      } else {
        next = tag.end;
        if (tag.closing) {
          // An open `redacted` above the element this closes was never closed by a `</redacted>`: a marker.
          while (stack.length > 0 && stack[stack.length - 1]?.name !== tag.name) {
            const top = stack.pop();
            if (top?.name === 'redacted' && top.end - top.start === REDACTED.length) {
              strays.push(top.start);
            }
          }
          stack.pop();
        } else if (!tag.selfClosing) {
          stack.push({ name: tag.name, start: i, end: tag.end });
        }
      }
    }
    i = next === -1 ? -1 : xml.indexOf('<', next);
  }
  for (const open of stack) {
    if (open.name === 'redacted' && open.end - open.start === REDACTED.length) {
      strays.push(open.start);
    }
  }
  if (strays.length === 0) {
    return xml;
  }
  strays.sort((a, b) => a - b);
  const parts: string[] = [];
  let kept = 0;
  for (const start of strays) {
    parts.push(xml.slice(kept, start), REDACTED_XML_MARKER);
    kept = start + REDACTED.length;
  }
  parts.push(xml.slice(kept));
  return parts.join('');
}

/**
 * True when `text` contains the redaction marker, raw or as XML text — i.e. it was produced by a
 * `redact*` helper. The raw form is also what XML History entries recorded before the escaped
 * marker hold.
 */
export function containsRedaction(text: string): boolean {
  return text.includes(REDACTED_MARKER) || text.includes(REDACTED_XML_MARKER);
}

/** Header names (case-insensitive) whose value is always masked. */
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);

/** True when a header named `name` (any case) always carries a credential; see {@link redactHeaders}. */
export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

/** A Negotiate reply token is a credential; the challenge's other schemes and realms stay readable. */
export function maskNegotiateTokens(value: string): string {
  return value.replace(/(^\s*|,\s*)(Negotiate)\s+[A-Za-z0-9+/=]+/gi, '$1$2 <redacted>');
}

function isChallengeHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'www-authenticate' || lower === 'proxy-authenticate';
}

/** The value of a header that is not wholly masked: a challenge still has its Negotiate token masked. */
function unmaskedValue(name: string, value: string): string {
  return isChallengeHeader(name) ? maskNegotiateTokens(value) : value;
}

/**
 * The test every header redactor applies: a well-known credential header, or one of `extraHeaders`
 * — the name an API key was configured under, which may be anything (`Ocp-Apim-Subscription-Key`).
 * Both compared case-insensitively.
 */
function headerIsMasked(name: string, extraHeaders: readonly string[] | undefined): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADERS.has(lower) || (extraHeaders?.some((extra) => extra.toLowerCase() === lower) ?? false);
}

/**
 * Masks the values of sensitive headers in a plain header map, case-insensitively. `extraHeaders`
 * names more headers to mask, as `redactUrl`'s `extraParams` does for query parameters.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  opts?: { show?: boolean; extraHeaders?: readonly string[] },
): Record<string, string> {
  if (opts?.show) {
    return { ...headers };
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = headerIsMasked(name, opts?.extraHeaders) ? REDACTED : unmaskedValue(name, value);
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
  opts?: { show?: boolean; extraHeaders?: readonly string[] },
): [string, string][] {
  const show = opts?.show ?? false;
  return pairs.map(([name, value]) => [
    name,
    show ? value : headerIsMasked(name, opts?.extraHeaders) ? REDACTED : unmaskedValue(name, value),
  ]);
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

/** True when a query parameter named `name` (any case) carries a credential; see {@link redactUrl}. */
export function isSensitiveQueryParam(name: string): boolean {
  return SENSITIVE_QUERY_PARAMS.has(name.toLowerCase());
}

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
 * Masks the query of a raw request line (`GET /calc?key=secret HTTP/1.1`) by the same rules as
 * {@link redactUrl}, `extraParams` included. The target is usually origin-form (a path), so it is
 * parsed against a placeholder origin and the origin taken off again. Anything that is not a
 * request line — a response's status line, a header — is returned unchanged.
 */
function redactRequestLine(line: string, extraParams?: readonly string[]): string {
  // Split rather than matched with one pattern: `\S*\?\S*` backtracks polynomially on a line of `?`s.
  const parts = line.split(' ');
  if (parts.length !== 3) {
    return line;
  }
  const [method = '', target = '', version = ''] = parts;
  if (method === '' || !target.includes('?') || !/^HTTP\/\d(?:\.\d)?$/.test(version)) {
    return line;
  }
  const originForm = target.startsWith('/');
  const base = 'http://request-line.invalid';
  const url = originForm ? `${base}${target}` : target;
  const redacted = redactUrl(url, { extraParams: extraParams ?? [] });
  if (redacted === url) {
    return line;
  }
  return `${method} ${originForm ? redacted.slice(base.length) : redacted} ${version}`;
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

/** Open tags of the token containers whose secrets are masked (any prefix). */
const TOKEN_OPEN_RE = /<(?:[\w-]+:)?(Assertion|EncryptedAssertion|RequestedProofToken|Entropy)\b/g;
/** Values inside a token that make it usable: its signature, its ciphertext, or a proof key. */
const TOKEN_SECRET_RE = /<((?:[\w-]+:)?(?:SignatureValue|CipherValue|BinarySecret))\b/g;
/** A BinarySecurityToken's open tag start; the ValueType is tested on the whole tag afterwards. */
const BST_OPEN_RE = /<((?:[\w-]+:)?BinarySecurityToken)\b/g;

/** The local name of the tag text between `<` and `>` (no leading `/`), and whether it closes. */
function tagNameOf(tag: string): { closing: boolean; name: string } {
  const closing = tag.startsWith('/');
  let start = closing ? 1 : 0;
  let end = start;
  while (end < tag.length && !' \t\r\n/'.includes(tag.charAt(end))) {
    if (tag.charAt(end) === ':') {
      start = end + 1;
    }
    end += 1;
  }
  return { closing, name: tag.slice(start, end) };
}

/**
 * The index just past the element whose open tag ended at `from`, counting nested elements of
 * the same local name; -1 when it never closes. One forward pass: each step moves past a tag.
 */
function closeOf(text: string, from: number, name: string): number {
  let depth = 1;
  let at = from;
  for (;;) {
    const lt = text.indexOf('<', at);
    if (lt === -1) {
      return -1;
    }
    const gt = text.indexOf('>', lt);
    if (gt === -1) {
      return -1;
    }
    const tag = tagNameOf(text.slice(lt + 1, gt));
    if (tag.name === name) {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) {
          return gt + 1;
        }
      } else if (text.charAt(gt - 1) !== '/') {
        depth += 1;
      }
    }
    at = gt + 1;
  }
}

/**
 * `text` with the content of every element matched by `openRe` replaced by the marker. The open
 * tag is the match plus everything up to the next `>`; `accept` can veto one by its whole tag. The
 * content runs to the first matching close tag, and the scan resumes past it.
 */
function maskElements(text: string, openRe: RegExp, accept: (openTag: string) => boolean): string {
  const open = new RegExp(openRe.source, 'g');
  let out = '';
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const found = open.exec(text);
    if (found === null) {
      break;
    }
    const tagEnd = text.indexOf('>', found.index);
    if (tagEnd === -1) {
      break;
    }
    const openTag = text.slice(found.index, tagEnd + 1);
    if (!accept(openTag) || text.charAt(tagEnd - 1) === '/') {
      out += text.slice(from, tagEnd + 1);
      from = tagEnd + 1;
      continue;
    }
    const closeTag = `</${found[1] ?? ''}>`;
    const closeAt = text.indexOf(closeTag, tagEnd + 1);
    if (closeAt === -1) {
      break;
    }
    out += `${text.slice(from, tagEnd + 1)}${REDACTED_XML_MARKER}${closeTag}`;
    from = closeAt + closeTag.length;
  }
  return out + text.slice(from);
}

/**
 * Masks what makes a security token usable while keeping it readable: the signature and
 * ciphertext inside SAML assertions and proof tokens, and the whole content of a Kerberos
 * `BinarySecurityToken`. X.509 tokens are public and stay. Forward scans only, never a
 * backtracking regex: responses are untrusted.
 */
export function redactSecurityTokens(text: string): string {
  let out = '';
  let from = 0;
  const open = new RegExp(TOKEN_OPEN_RE.source, 'g');
  for (;;) {
    open.lastIndex = from;
    const found = open.exec(text);
    if (found === null) {
      break;
    }
    const tagEnd = text.indexOf('>', found.index);
    if (tagEnd === -1) {
      break;
    }
    if (text.charAt(tagEnd - 1) === '/') {
      // An empty container holds nothing to mask; looking for its close tag would swallow the
      // next real token's and leave that one's secrets showing.
      out += text.slice(from, tagEnd + 1);
      from = tagEnd + 1;
      continue;
    }
    // A container that never closes (a truncated body) runs to the end of the text: masking too
    // much beats stopping here and leaving a later token's secrets showing.
    const closed = closeOf(text, tagEnd + 1, found[1] ?? 'Assertion');
    const end = closed === -1 ? text.length : closed;
    out += text.slice(from, found.index) + maskElements(text.slice(found.index, end), TOKEN_SECRET_RE, () => true);
    from = end;
  }
  return maskElements(out + text.slice(from), BST_OPEN_RE, (tag) => tag.includes('Kerberosv5_AP_REQ'));
}

/**
 * Masks the text content of `wsse:Password` elements (any namespace prefix) in raw XML — except
 * a `#PasswordDigest` value, which is a hash, not a secret, and must reach the wire intact. The
 * content becomes {@link REDACTED_XML_MARKER}, so the document stays well formed.
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
    const content = isPasswordDigest(openTag) ? text.slice(tagEnd + 1, closed.index) : REDACTED_XML_MARKER;
    out += `${text.slice(from, tagEnd + 1)}${content}${closed[0]}`;
    from = closed.index + closed[0].length;
  }
  return redactSecurityTokens(out + text.slice(from));
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

/** The default body-key test: one of {@link SECRET_BODY_KEYS}, any case. */
function isSecretBodyKey(key: string): boolean {
  return SECRET_BODY_KEY_SET.has(key.toLowerCase());
}

/** A copy with every secret-keyed value replaced whole — a nested object or array under one too. */
function maskJson(value: unknown, isSecret: (key: string) => boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskJson(item, isSecret));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, isSecret(key) ? REDACTED : maskJson(inner, isSecret)]),
    );
  }
  return value;
}

/** The indentation of the input's second line, so a pretty body stays pretty and a compact one compact. */
function indentOf(text: string): number | undefined {
  const match = /\n( +)\S/.exec(text);
  return match?.[1]?.length;
}

function maskFormPair(pair: string, isSecret: (key: string) => boolean): string {
  const eq = pair.indexOf('=');
  const rawKey = eq < 0 ? pair : pair.slice(0, eq);
  let key: string;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    key = rawKey;
  }
  return isSecret(key) ? `${rawKey}=${encodeURIComponent(REDACTED)}` : pair;
}

/**
 * Masks secret-keyed values in a JSON (`application/json`, `+json`) or urlencoded form body;
 * anything else, or JSON that does not parse, is returned as is. `isSecretKey` replaces the
 * {@link SECRET_BODY_KEYS} test — an importer passes its wider one; the live send never does.
 */
export function redactStructuredBody(
  text: string,
  contentType: string | undefined,
  opts?: { show?: boolean; isSecretKey?: (key: string) => boolean },
): string {
  if (opts?.show === true || contentType === undefined) {
    return text;
  }
  const isSecret = opts?.isSecretKey ?? isSecretBodyKey;
  if (isJsonType(contentType)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    return JSON.stringify(maskJson(parsed, isSecret), null, indentOf(text));
  }
  if (isFormType(contentType)) {
    return text
      .split('&')
      .map((pair) => maskFormPair(pair, isSecret))
      .join('&');
  }
  return text;
}

/** Masks a single raw `name: value` header line (no terminator), case-insensitively. */
function redactHeaderLine(line: string, extraHeaders: readonly string[] | undefined): string {
  const idx = line.indexOf(':');
  if (idx < 0) {
    return line;
  }
  const name = line.slice(0, idx).trim();
  if (!headerIsMasked(name, extraHeaders)) {
    return isChallengeHeader(name) ? `${line.slice(0, idx + 1)}${maskNegotiateTokens(line.slice(idx + 1))}` : line;
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
export function redactRawHttp(
  input: string,
  opts?: {
    show?: boolean;
    encoding?: 'text' | 'base64';
    extraParams?: readonly string[];
    extraHeaders?: readonly string[];
  },
): string {
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
    .map((part, index) =>
      index === 0
        ? redactRequestLine(part, opts?.extraParams)
        : index % 2 === 0
          ? redactHeaderLine(part, opts?.extraHeaders)
          : part,
    )
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
