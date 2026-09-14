/**
 * Turning a {@link RestBody} into the bytes and `Content-Type` that go on the wire.
 *
 * Every kind is encoded here and nowhere else, so what the cURL export shows and what the
 * transport sends come from one function. Files are never read by the engine itself: a
 * {@link FileResolver} is injected, exactly as the SOAP attachment path does it, so the host keeps
 * ownership of the project directory and its cache (ADR-0005).
 */

import { randomBytes } from 'node:crypto';
import { WirebenchError } from '../errors.js';
import type { AttachmentSource } from '../project/model.js';
import { encodeBody } from '../soap/charset.js';
import { mediaTypeOf } from '../soap/mime/multipart.js';
import type { KeyValueEntry, MultipartFormPart, RawLanguage, RestBody } from './model.js';
import { RAW_LANGUAGE_CONTENT_TYPES } from './model.js';

const CRLF = '\r\n';

/** Reads the bytes behind one file reference. Rejects when the file cannot be read. */
export type FileResolver = (source: AttachmentSource) => Promise<Uint8Array>;

/** Options for {@link encodeRestBody}. */
export interface EncodeBodyOptions {
  /** How a `multipart` or `binary` body's files are read. Required for those kinds only. */
  readonly resolveFile?: FileResolver;
  /** Charset for a raw or form body. Default `utf-8`; see `soap/charset.ts` for the labels. */
  readonly charset?: string;
  /** Fixed multipart boundary; a random one is generated otherwise. Tests inject it. */
  readonly boundary?: string;
  readonly signal?: AbortSignal;
}

/** What one body contributes to the request: its bytes, and the type that describes them. */
export interface EncodedBody {
  /** Absent for `{kind: 'none'}` — not an empty array, which would still send `Content-Length: 0`. */
  readonly bytes?: Uint8Array;
  /** Absent when the body does not imply one; a header the request sets itself always wins. */
  readonly contentType?: string;
}

/** A fresh multipart boundary: long, random, and unable to occur in base64 or text. */
function newBoundary(): string {
  return `----WirebenchBoundary${randomBytes(16).toString('hex')}`;
}

/** The `Content-Type` a raw body implies when neither the body nor a header names one. */
export function rawContentType(language: RawLanguage, declared: string | undefined, charset?: string): string {
  const base = declared ?? RAW_LANGUAGE_CONTENT_TYPES[language];
  if (charset === undefined || /charset=/i.test(base)) {
    return base;
  }
  const normalized = charset.toLowerCase();
  return normalized === 'utf-8' || normalized === 'utf8' ? base : `${base}; charset=${charset}`;
}

/**
 * `application/x-www-form-urlencoded`, per the URL-encoded form serialisation every HTML form and
 * every server that parses one uses: space becomes `+`, everything else percent-encodes, and a
 * disabled row is simply not there.
 */
export function encodeFormFields(fields: readonly KeyValueEntry[]): string {
  return fields
    .filter((field) => field.enabled)
    .map((field) => `${formEncode(field.name)}=${formEncode(field.value)}`)
    .join('&');
}

function formEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/** Escapes a `filename`/`name` parameter for a `Content-Disposition` header (RFC 7578 §4.2). */
function quoted(value: string): string {
  return `"${value.replace(/[\r\n"]/g, '_')}"`;
}

/** The file name a part advertises: the one it was given, else the last segment of its path. */
function partFileName(part: Extract<MultipartFormPart, { kind: 'file' }>): string {
  if (part.fileName !== undefined) {
    return part.fileName;
  }
  return part.source.kind === 'path' ? (part.source.path.split(/[\\/]/).pop() ?? part.name) : part.name;
}

/**
 * Builds a `multipart/form-data` body (RFC 7578).
 *
 * Parts are written in author order, text before file only if that is how they were ordered — some
 * services genuinely require a field before the file it describes, so nothing is reordered here.
 * A text part gets a `Content-Type` only when it asked for one, since a server that sees none
 * treats the part as `text/plain`, which is what an unadorned field means.
 */
async function encodeMultipart(parts: readonly MultipartFormPart[], options: EncodeBodyOptions): Promise<EncodedBody> {
  const boundary = options.boundary ?? newBoundary();
  const chunks: Uint8Array[] = [];
  const push = (text: string): void => {
    chunks.push(new TextEncoder().encode(text));
  };

  for (const part of parts) {
    if (!part.enabled) {
      continue;
    }
    options.signal?.throwIfAborted();
    if (part.kind === 'text') {
      push(`--${boundary}${CRLF}Content-Disposition: form-data; name=${quoted(part.name)}${CRLF}`);
      push(part.contentType !== undefined ? `Content-Type: ${part.contentType}${CRLF}${CRLF}` : CRLF);
      chunks.push(encodeBody(part.value, options.charset));
      push(CRLF);
      continue;
    }
    const resolveFile = options.resolveFile;
    if (resolveFile === undefined) {
      throw new WirebenchError('rest-file-unresolved', 'A multipart file part needs a file resolver', {
        details: { part: part.name },
      });
    }
    const bytes = await resolveFile(part.source);
    push(
      `--${boundary}${CRLF}Content-Disposition: form-data; name=${quoted(part.name)}; filename=${quoted(
        partFileName(part),
      )}${CRLF}Content-Type: ${part.contentType ?? 'application/octet-stream'}${CRLF}${CRLF}`,
    );
    chunks.push(bytes);
    push(CRLF);
  }
  push(`--${boundary}--${CRLF}`);

  return { bytes: concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Joins byte chunks into one buffer, allocating exactly once. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Encodes one request body.
 *
 * `{kind: 'none'}` produces no bytes at all rather than an empty buffer, so a `GET` does not
 * announce a zero-length body it does not have. Every other kind produces both bytes and the
 * `Content-Type` that describes them; the caller decides whether a header the request set itself
 * overrides it (`rest/send.ts` does).
 *
 * @throws WirebenchError `rest-file-unresolved` when a file part or binary body has no resolver
 */
export async function encodeRestBody(body: RestBody, options: EncodeBodyOptions = {}): Promise<EncodedBody> {
  switch (body.kind) {
    case 'none':
      return {};
    case 'raw':
      return {
        bytes: encodeBody(body.text, options.charset),
        contentType: rawContentType(body.language, body.contentType, options.charset),
      };
    case 'form':
      return {
        bytes: encodeBody(encodeFormFields(body.fields), options.charset),
        contentType: 'application/x-www-form-urlencoded',
      };
    case 'multipart':
      return encodeMultipart(body.parts, options);
    case 'binary': {
      const resolveFile = options.resolveFile;
      if (resolveFile === undefined) {
        throw new WirebenchError('rest-file-unresolved', 'A binary body needs a file resolver', {
          details: { source: body.source.kind },
        });
      }
      return { bytes: await resolveFile(body.source), contentType: body.contentType };
    }
  }
}

/**
 * XML- or JSON-escapes a value being substituted into a body, for the *escape properties* setting.
 *
 * Only the characters that would otherwise change the document's structure are touched. A JSON
 * body gets JSON string escaping (without the surrounding quotes, since the value is substituted
 * inside them); an XML body gets the five predefined entities; anything else is left alone,
 * because there is no general escape for `text/plain`.
 */
export function escapeForLanguage(value: string, language: RawLanguage | 'form'): string {
  if (language === 'json') {
    const json = JSON.stringify(value);
    return json.slice(1, -1);
  }
  if (language === 'xml' || language === 'html') {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  return value;
}

/** The language a body's escaping follows, for {@link escapeForLanguage}. */
export function bodyLanguage(body: RestBody): RawLanguage | 'form' | undefined {
  switch (body.kind) {
    case 'raw':
      return body.language;
    case 'form':
    case 'multipart':
      return 'form';
    default:
      return undefined;
  }
}

/** The media type of an encoded body, without its parameters; `undefined` when it has none. */
export function encodedMediaType(encoded: EncodedBody): string | undefined {
  return encoded.contentType === undefined ? undefined : mediaTypeOf(encoded.contentType);
}
