/**
 * Building and parsing `multipart/related` bodies (RFC 2387), the container both
 * MTOM/XOP and SOAP with Attachments use.
 *
 * Building is strict — CRLF everywhere, a boundary guaranteed not to occur inside any
 * part — because that is what goes on the wire. Parsing is deliberately tolerant, because
 * what comes back rarely is: LF-only line endings, a missing final `--` terminator,
 * unquoted boundary parameters, folded headers and a missing `start` parameter are all
 * accepted and reported as problems rather than raised.
 */

import { randomBytes } from 'node:crypto';
import type { BuildTransferEncoding, MimePart, MultipartPart, MultipartRoot, TransferEncoding } from './types.js';

/** Default Content-ID of the envelope part when the caller does not choose one. */
export const DEFAULT_ROOT_CONTENT_ID = 'rootpart@wirebench';

const CRLF = '\r\n';
const KNOWN_ENCODINGS: readonly string[] = ['binary', 'base64', '8bit', '7bit', 'quoted-printable'];

/** What {@link buildMultipartRelated} needs to write a body. */
export interface BuildMultipartInput {
  readonly root: MultipartRoot;
  readonly parts: readonly MultipartPart[];
  /** Fixed boundary (tests); a random one is generated otherwise. Replaced if it collides. */
  readonly boundary?: string;
  /** Package as MTOM: adds the `start-info` parameter naming the SOAP content type. */
  readonly mtom?: boolean;
}

/** A built `multipart/related` body plus the `Content-Type` that describes it. */
export interface BuiltMultipart {
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly boundary: string;
}

/** What {@link parseMultipartRelated} found. */
export interface ParsedMultipart {
  /** The `start` part, or the first part when no usable `start` parameter was given. */
  readonly root: MimePart;
  /** Every part but the root, in wire order. */
  readonly parts: readonly MimePart[];
  /** Tolerance notes, e.g. `missing-boundary`, `missing-final-boundary`, `start-part-not-found`. */
  readonly problems: readonly string[];
}

/** The media type of a `Content-Type` header value, without its parameters. */
export function mediaTypeOf(contentType: string): string {
  const semicolon = contentType.indexOf(';');
  return (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim();
}

/** One parameter of a `Content-Type`-style header value, unquoted; case-insensitive on the name. */
export function mimeParameter(header: string, name: string): string | undefined {
  // The quoted-string branch follows RFC 2045's grammar: any character except `"` and `\`,
  // or a backslash-escaped pair, so a value written by {@link quoteParameter} round-trips.
  const pattern = new RegExp(`;\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))`, 'i');
  const match = pattern.exec(header);
  if (match === null) {
    return undefined;
  }
  const quoted = match[1];
  return quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : match[2];
}

/**
 * Replaces CR, LF and other control characters in a header value component with `_`.
 *
 * Used for every value that lands unquoted on the wire (`Content-ID`, `Content-Type`) so a
 * user-authored string (an attachment name, a resolved content type) cannot smuggle in a
 * second header line.
 */
function sanitizeHeaderValue(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? '_' : char;
  }
  return out;
}

/**
 * Quotes a MIME parameter value for a header line: sanitizes control characters (see
 * {@link sanitizeHeaderValue}), then backslash-escapes `"` and `\` per RFC 2045's
 * quoted-string grammar. Use for every quoted parameter this module writes — `filename`,
 * `name`, `type`, `start`, `start-info`, `boundary` — since all of them can carry
 * user-authored text.
 */
function quoteParameter(value: string): string {
  return `"${sanitizeHeaderValue(value).replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/** Strips the angle brackets from a Content-ID (`<a@b>` -> `a@b`). */
export function stripContentId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

/** Base64 with the 76-column CRLF wrapping MIME expects. */
function toBase64Lines(bytes: Uint8Array): Buffer {
  const encoded = Buffer.from(bytes).toString('base64');
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return Buffer.from(lines.join(CRLF), 'ascii');
}

/** The bytes of a part as they go on the wire, honouring its transfer encoding. */
function encodePart(bytes: Uint8Array, encoding: BuildTransferEncoding | undefined): Buffer {
  return encoding === 'base64' ? toBase64Lines(bytes) : Buffer.from(bytes);
}

/** A boundary that does not occur in any of `chunks`, starting from `preferred`. */
function chooseBoundary(preferred: string | undefined, chunks: readonly Buffer[]): string {
  let candidate = preferred ?? `----=_Part_${randomBytes(12).toString('hex')}`;
  let attempts = 0;
  while (chunks.some((chunk) => chunk.includes(candidate, 0, 'utf-8'))) {
    candidate = `----=_Part_${randomBytes(12).toString('hex')}`;
    attempts += 1;
    /* c8 ignore next 3 -- a 96-bit random boundary colliding twice is not reachable in a test. */
    if (attempts > 8) {
      throw new Error('could not choose a MIME boundary');
    }
  }
  return candidate;
}

/** `Content-Disposition` for a part that names a file and/or a WSDL mime part. */
function dispositionHeader(part: MultipartPart): string | undefined {
  const attributes: string[] = [];
  if (part.partName !== undefined && part.partName.length > 0) {
    attributes.push(`name=${quoteParameter(part.partName)}`);
  }
  if (part.fileName !== undefined && part.fileName.length > 0) {
    attributes.push(`filename=${quoteParameter(part.fileName)}`);
  }
  return attributes.length === 0 ? undefined : `attachment; ${attributes.join('; ')}`;
}

/**
 * Writes a `multipart/related` body and the `Content-Type` header describing it.
 *
 * The `type` parameter names the root part's media type and `start` points at its
 * Content-ID, so a receiver can find the envelope without relying on part order. For
 * MTOM, `start-info` additionally carries the content type the XOP package encodes
 * (`text/xml` for SOAP 1.1, `application/soap+xml` for 1.2), taken from the root part's
 * own `type` parameter.
 *
 * @param input the root (envelope) part, the attachment parts, and packaging options
 */
export function buildMultipartRelated(input: BuildMultipartInput): BuiltMultipart {
  const rootBytes = Buffer.from(input.root.bytes);
  const encoded = input.parts.map((part) => encodePart(part.bytes, part.transferEncoding));
  const boundary = chooseBoundary(input.boundary, [rootBytes, ...encoded]);
  const rootContentId = sanitizeHeaderValue(input.root.contentId ?? DEFAULT_ROOT_CONTENT_ID);
  const rootContentType = sanitizeHeaderValue(input.root.contentType);

  const chunks: Buffer[] = [];
  const push = (text: string): void => void chunks.push(Buffer.from(text, 'utf-8'));

  push(`--${boundary}${CRLF}`);
  push(`Content-Type: ${rootContentType}${CRLF}`);
  push(`Content-Transfer-Encoding: 8bit${CRLF}`);
  push(`Content-ID: <${rootContentId}>${CRLF}${CRLF}`);
  chunks.push(rootBytes);

  input.parts.forEach((part, index) => {
    push(`${CRLF}--${boundary}${CRLF}`);
    push(`Content-Type: ${sanitizeHeaderValue(part.contentType)}${CRLF}`);
    push(`Content-Transfer-Encoding: ${part.transferEncoding ?? 'binary'}${CRLF}`);
    push(`Content-ID: <${sanitizeHeaderValue(part.contentId)}>${CRLF}`);
    const disposition = dispositionHeader(part);
    if (disposition !== undefined) {
      push(`Content-Disposition: ${disposition}${CRLF}`);
    }
    push(CRLF);
    chunks.push(encoded[index] ?? Buffer.alloc(0));
  });
  push(`${CRLF}--${boundary}--${CRLF}`);

  const rootType = mediaTypeOf(rootContentType);
  const startInfo = input.mtom === true ? (mimeParameter(rootContentType, 'type') ?? 'text/xml') : undefined;
  const contentType =
    `multipart/related; type=${quoteParameter(rootType)}; start=${quoteParameter(`<${rootContentId}>`)}; boundary=${quoteParameter(boundary)}` +
    (startInfo === undefined ? '' : `; start-info=${quoteParameter(startInfo)}`);

  return { contentType, body: new Uint8Array(Buffer.concat(chunks)), boundary };
}

/** Decodes RFC 2045 quoted-printable text, honouring soft line breaks. */
function decodeQuotedPrintable(raw: Buffer): Buffer {
  const decoded = raw
    .toString('latin1')
    .replace(/=(?:\r\n|\n|\r)/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(decoded, 'latin1');
}

/** Splits one part's raw bytes into unfolded headers and a body, tolerating LF-only breaks. */
function splitHeaders(segment: Buffer): { headers: Record<string, string>; body: Buffer } {
  const lines: string[] = [];
  let cursor = 0;
  let bodyStart = segment.length;
  while (cursor < segment.length) {
    const newline = segment.indexOf(0x0a, cursor);
    const lineEnd = newline === -1 ? segment.length : newline;
    const trimmedEnd = lineEnd > cursor && segment[lineEnd - 1] === 0x0d ? lineEnd - 1 : lineEnd;
    const line = segment.toString('utf-8', cursor, trimmedEnd);
    const next = newline === -1 ? segment.length : newline + 1;
    if (line.length === 0) {
      bodyStart = next;
      break;
    }
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''} ${line.trim()}`;
    } else {
      lines.push(line);
    }
    cursor = next;
    bodyStart = next;
  }

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name.length > 0 && headers[name] === undefined) {
      headers[name] = line.slice(colon + 1).trim();
    }
  }
  return { headers, body: segment.subarray(bodyStart) };
}

/** The last `/`-separated, non-empty segment of a `Content-Location` value, sans query/fragment. */
function lastPathSegment(contentLocation: string | undefined): string | undefined {
  if (contentLocation === undefined) {
    return undefined;
  }
  const withoutQuery = contentLocation.trim().split(/[?#]/, 1)[0] ?? '';
  const segments = withoutQuery.split('/');
  const last = segments[segments.length - 1];
  return last !== undefined && last.length > 0 ? last : undefined;
}

/** Turns one raw part segment into a {@link MimePart}, decoding its transfer encoding. */
function toMimePart(segment: Buffer, fallbackContentType: string): MimePart {
  const { headers, body } = splitHeaders(segment);
  const encodingHeader = headers['content-transfer-encoding']?.toLowerCase();
  const transferEncoding =
    encodingHeader !== undefined && KNOWN_ENCODINGS.includes(encodingHeader)
      ? (encodingHeader as TransferEncoding)
      : undefined;
  const raw = Buffer.from(body);
  const decoded =
    transferEncoding === 'base64'
      ? Buffer.from(raw.toString('ascii').replace(/\s+/g, ''), 'base64')
      : transferEncoding === 'quoted-printable'
        ? decodeQuotedPrintable(raw)
        : raw;
  const disposition = headers['content-disposition'];
  const dispositionFileName =
    disposition === undefined ? undefined : (mimeParameter(`;${disposition}`, 'filename') ?? undefined);
  const fileName = dispositionFileName ?? lastPathSegment(headers['content-location']);
  const partName = disposition === undefined ? undefined : (mimeParameter(`;${disposition}`, 'name') ?? undefined);
  const contentId = headers['content-id'];

  return {
    headers,
    ...(contentId !== undefined ? { contentId: stripContentId(contentId) } : {}),
    contentType: headers['content-type'] ?? fallbackContentType,
    ...(transferEncoding !== undefined ? { transferEncoding } : {}),
    bytes: new Uint8Array(decoded),
    raw: new Uint8Array(raw),
    ...(fileName !== undefined ? { fileName } : {}),
    ...(partName !== undefined ? { partName } : {}),
  };
}

/** Every `--boundary` delimiter line in `buf`, with where the segment after it starts. */
function findDelimiters(
  buf: Buffer,
  boundary: string,
): readonly { readonly start: number; readonly contentStart: number; readonly terminator: boolean }[] {
  const token = Buffer.from(`--${boundary}`, 'utf-8');
  const found: { start: number; contentStart: number; terminator: boolean }[] = [];
  let from = 0;
  for (;;) {
    const at = buf.indexOf(token, from);
    if (at === -1) {
      break;
    }
    from = at + token.length;
    if (at !== 0 && buf[at - 1] !== 0x0a) {
      continue;
    }
    let cursor = from;
    const terminator = buf[cursor] === 0x2d && buf[cursor + 1] === 0x2d;
    if (terminator) {
      cursor += 2;
    }
    while (buf[cursor] === 0x20 || buf[cursor] === 0x09) {
      cursor += 1;
    }
    if (buf[cursor] === 0x0d) {
      cursor += 1;
    }
    if (buf[cursor] === 0x0a) {
      cursor += 1;
    }
    found.push({ start: at, contentStart: cursor, terminator });
  }
  return found;
}

/**
 * Parses a `multipart/related` body.
 *
 * Never throws: a body that cannot be split (no `boundary` parameter, no delimiters at
 * all) is returned whole as the root part with a problem describing why, so a caller can
 * still show the response it actually received.
 *
 * @param bytes the raw body bytes
 * @param contentTypeHeader the `Content-Type` header that described them
 */
export function parseMultipartRelated(bytes: Uint8Array, contentTypeHeader: string): ParsedMultipart {
  const buf = Buffer.from(bytes);
  const problems: string[] = [];
  const boundary = mimeParameter(contentTypeHeader, 'boundary');
  const fallbackContentType = mediaTypeOf(contentTypeHeader) || 'application/octet-stream';

  const wholeBody = (problem: string): ParsedMultipart => {
    problems.push(problem);
    return {
      root: { headers: {}, contentType: fallbackContentType, bytes: new Uint8Array(buf), raw: new Uint8Array(buf) },
      parts: [],
      problems,
    };
  };

  if (boundary === undefined || boundary.length === 0) {
    return wholeBody('missing-boundary');
  }
  const delimiters = findDelimiters(buf, boundary);
  const openers = delimiters.filter((d) => !d.terminator);
  if (openers.length === 0) {
    return wholeBody('no-parts');
  }
  if (!delimiters.some((d) => d.terminator)) {
    problems.push('missing-final-boundary');
  }

  const parts: MimePart[] = [];
  for (const opener of openers) {
    const next = delimiters.find((d) => d.start > opener.start);
    // The CRLF (or LF) in front of a delimiter belongs to the delimiter, not to the part.
    // A truncated message has no delimiter after its last part, so the same line break is
    // dropped there too: the sender wrote it ahead of the terminator it never sent.
    let end = next === undefined ? buf.length : next.start;
    if (end > opener.contentStart && buf[end - 1] === 0x0a) {
      end -= 1;
    }
    if (end > opener.contentStart && buf[end - 1] === 0x0d) {
      end -= 1;
    }
    parts.push(toMimePart(buf.subarray(opener.contentStart, end), fallbackContentType));
  }

  const start = mimeParameter(contentTypeHeader, 'start');
  let rootIndex = 0;
  if (start !== undefined) {
    const wanted = stripContentId(start);
    const found = parts.findIndex((part) => part.contentId === wanted);
    if (found === -1) {
      problems.push('start-part-not-found');
    } else {
      rootIndex = found;
    }
  }

  const root = parts[rootIndex];
  /* c8 ignore next 3 -- rootIndex always indexes a part that exists. */
  if (root === undefined) {
    return wholeBody('no-parts');
  }
  return { root, parts: parts.filter((_part, index) => index !== rootIndex), problems };
}
