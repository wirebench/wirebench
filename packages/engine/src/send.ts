/**
 * Sends an already-built SOAP envelope over HTTP and structurally parses the
 * response: SOAP version, fault, or "not actually SOAP" detection.
 */

import type { Dispatcher } from 'undici';
import { WirebenchError } from './errors.js';
import { sendHttp } from './http/client.js';
import type { HttpRequest } from './http/types.js';
import { parseSoapResponse } from './soap/response-parser.js';
import { soapActionHeaders } from './soap/soap-action.js';
import type { SoapExchange, SoapSendInput } from './types.js';

/** Case-insensitively merges `override` onto `base`, letting `override`'s casing win for shared keys. */
function mergeHeaders(
  base: Readonly<Record<string, string>>,
  override: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...base };
  const lowerToKey = new Map(Object.keys(merged).map((key) => [key.toLowerCase(), key]));
  for (const [key, value] of Object.entries(override)) {
    const existingKey = lowerToKey.get(key.toLowerCase());
    if (existingKey !== undefined && existingKey !== key) {
      delete merged[existingKey];
    }
    merged[key] = value;
    lowerToKey.set(key.toLowerCase(), key);
  }
  return merged;
}

/** Looks up a header case-insensitively. */
function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

/** The charset declared in a `Content-Type` header value, if any. */
function charsetOf(contentType: string | undefined): string | undefined {
  const match = contentType !== undefined ? /charset=([^;]+)/i.exec(contentType) : null;
  return match?.[1]?.trim().replace(/^"|"$/g, '');
}

/** Encodes `text` for the wire, per `encoding` (default utf-8). */
function encodeBody(text: string, encoding: string | undefined): Uint8Array {
  const normalized = (encoding ?? 'utf-8').toLowerCase();
  if (normalized === 'utf-8' || normalized === 'utf8') {
    return new TextEncoder().encode(text);
  }
  if (Buffer.isEncoding(normalized)) {
    return new Uint8Array(Buffer.from(text, normalized));
  }
  throw new WirebenchError('unsupported-encoding', `Unsupported request encoding "${encoding}"`, {
    details: { encoding },
  });
}

/** Decodes a response body per its `Content-Type` charset (default UTF-8), falling back to UTF-8 with a `decode-error` problem when the charset label is unsupported or the bytes are invalid for it. */
function decodeBody(
  body: Uint8Array,
  contentType: string | undefined,
): { text: string; problem?: SoapExchange['problems'][number] } {
  const label = charsetOf(contentType) ?? 'utf-8';
  try {
    return { text: new TextDecoder(label, { fatal: false }).decode(body) };
  } catch {
    return {
      text: new TextDecoder('utf-8', { fatal: false }).decode(body),
      problem: {
        code: 'decode-error',
        message: `Response charset "${label}" is not supported; decoded as UTF-8 instead`,
      },
    };
  }
}

/**
 * Sends `input.envelopeXml` to `input.endpoint` over HTTP, computing the
 * `Content-Type`/`SOAPAction` headers for `input.soapVersion` and merging in
 * any caller-supplied `input.headers` (which override the computed ones,
 * matching SoapUI's behaviour).
 *
 * HTTP-layer failures (timeout, abort, DNS, TLS, ...) propagate as
 * {@link HttpError}; a non-2xx HTTP status is not an error and is returned
 * as a normal exchange for the caller to inspect.
 *
 * @param input the endpoint, envelope and transport options to send
 * @param options an injected `dispatcher` (tests) and/or `now` clock
 */
export async function sendSoapRequest(
  input: SoapSendInput,
  options?: { readonly dispatcher?: Dispatcher; readonly now?: () => number },
): Promise<SoapExchange> {
  const charset =
    charsetOf(input.headers !== undefined ? headerValue(input.headers, 'content-type') : undefined) ?? 'UTF-8';
  const computed = soapActionHeaders(input.soapVersion, input.soapAction, {
    ...(input.skipSoapAction !== undefined ? { skipSoapAction: input.skipSoapAction } : {}),
    charset,
  });
  const headers = mergeHeaders({ 'content-type': computed.contentType, ...computed.headers }, input.headers ?? {});

  const body = encodeBody(input.envelopeXml, input.encoding);

  const request: HttpRequest = {
    url: input.endpoint,
    method: 'POST',
    headers,
    body,
    timeoutMs: input.timeoutMs ?? 60_000,
    followRedirects: input.followRedirects ?? false,
    ...(input.maxSizeBytes !== undefined ? { maxSizeBytes: input.maxSizeBytes } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.tls !== undefined ? { tls: input.tls } : {}),
    ...(input.proxy !== undefined ? { proxy: input.proxy } : {}),
  };

  const http = await sendHttp(request, options);

  const problems: Array<SoapExchange['problems'][number]> = [];
  const { text: envelopeXml, problem: decodeProblem } = decodeBody(
    http.body,
    headerValue(http.headers, 'content-type'),
  );
  if (decodeProblem !== undefined) {
    problems.push(decodeProblem);
  }

  let response: SoapExchange['response'];
  try {
    const parsed = parseSoapResponse(envelopeXml);
    response = {
      envelopeXml,
      version: parsed.version,
      ...(parsed.fault !== undefined ? { fault: parsed.fault } : {}),
      isSoap: true,
    };
  } catch (cause) {
    if (cause instanceof WirebenchError && cause.code === 'not-a-soap-envelope') {
      response = { envelopeXml, isSoap: false };
      problems.push({ code: 'not-soap', message: cause.message });
    } else if (cause instanceof WirebenchError && cause.code === 'xml-parse-error') {
      response = { envelopeXml, isSoap: false };
      problems.push({ code: 'xml-parse-error', message: cause.message });
    } else {
      throw cause;
    }
  }

  return {
    http,
    ...(response !== undefined ? { response } : {}),
    durationMs: http.timings.totalMs,
    problems,
  };
}
