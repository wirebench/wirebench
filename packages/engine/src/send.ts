/**
 * Sends an already-built SOAP envelope over HTTP and structurally parses the
 * response: SOAP version, fault, or "not actually SOAP" detection.
 */

import { gzipSync } from 'node:zlib';
import type { Dispatcher } from 'undici';
import { WirebenchError } from './errors.js';
import { sendHttp } from './http/client.js';
import type { HttpRequest } from './http/types.js';
import { expandSendInput } from './project/properties.js';
import type { PropertyScopes, UnresolvedRef } from './project/properties.js';
import { headerValue, mergeHeaders } from './http/headers.js';
import { charsetOf } from './soap/charset.js';
import { packageRequestBody, readResponseBody, type SoapProblem } from './soap/mime/send-pipeline.js';
import { parseSoapResponse } from './soap/response-parser.js';
import { soapActionHeaders } from './soap/soap-action.js';
import type { SoapExchange, SoapSendInput } from './types.js';

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
 * When `input.attachmentOptions` is given, the envelope additionally goes
 * through the attachment pipeline before it is sent — inline files, then MTOM,
 * then SwA — and a `multipart/related` response is unwrapped into its envelope
 * plus `response.attachments`. See `soap/mime/send-pipeline.ts`.
 *
 * When `options.scopes` is given, `input.endpoint`, `input.envelopeXml`,
 * `input.soapAction` and every header name/value are first passed through
 * {@link expandSendInput}; any expressions that could not be resolved are
 * left verbatim in the sent request and reported on the returned exchange's
 * `unresolved` field, rather than failing the send.
 *
 * @param input the endpoint, envelope and transport options to send
 * @param options an injected `dispatcher` (tests), `now` clock, and/or property `scopes`
 */
export async function sendSoapRequest(
  input: SoapSendInput,
  options?: { readonly dispatcher?: Dispatcher; readonly now?: () => number; readonly scopes?: PropertyScopes },
): Promise<SoapExchange> {
  let unresolved: readonly UnresolvedRef[] | undefined;
  let effectiveInput = input;
  if (options?.scopes !== undefined) {
    const expanded = expandSendInput(input, options.scopes, { entitize: input.entitize ?? false });
    effectiveInput = expanded.input;
    unresolved = expanded.unresolved;
  }

  const charset =
    charsetOf(effectiveInput.headers !== undefined ? headerValue(effectiveInput.headers, 'content-type') : undefined) ??
    'UTF-8';
  const computed = soapActionHeaders(effectiveInput.soapVersion, effectiveInput.soapAction, {
    ...(effectiveInput.skipSoapAction !== undefined ? { skipSoapAction: effectiveInput.skipSoapAction } : {}),
    charset,
  });
  const headers = mergeHeaders(
    { 'content-type': computed.contentType, ...computed.headers },
    effectiveInput.headers ?? {},
  );

  const problems: SoapProblem[] = [];
  // Attachments are packaged before compression, so gzip applies to the whole multipart
  // body exactly as it would to a plain envelope.
  const encoded = await packageRequestBody(effectiveInput, headers, problems);
  // Compression is applied after the headers are merged so a caller-supplied Content-Encoding
  // cannot silently disagree with what is actually on the wire.
  const body = effectiveInput.compressBody === 'gzip' ? new Uint8Array(gzipSync(encoded)) : encoded;
  if (effectiveInput.compressBody === 'gzip') {
    headers['content-encoding'] = 'gzip';
  }

  const request: HttpRequest = {
    url: effectiveInput.endpoint,
    method: 'POST',
    headers,
    body,
    timeoutMs: effectiveInput.timeoutMs ?? 60_000,
    followRedirects: effectiveInput.followRedirects ?? false,
    ...(effectiveInput.maxSizeBytes !== undefined ? { maxSizeBytes: effectiveInput.maxSizeBytes } : {}),
    ...(effectiveInput.localAddress !== undefined ? { localAddress: effectiveInput.localAddress } : {}),
    ...(effectiveInput.signal !== undefined ? { signal: effectiveInput.signal } : {}),
    ...(effectiveInput.tls !== undefined ? { tls: effectiveInput.tls } : {}),
    ...(effectiveInput.proxy !== undefined ? { proxy: effectiveInput.proxy } : {}),
  };

  const http = await sendHttp(request, options);

  const { envelopeXml, attachments } = readResponseBody(
    http.body,
    headerValue(http.headers, 'content-type'),
    effectiveInput.attachmentOptions,
    problems,
  );

  let response: SoapExchange['response'];
  try {
    const parsed = parseSoapResponse(envelopeXml);
    response = {
      envelopeXml,
      version: parsed.version,
      ...(parsed.fault !== undefined ? { fault: parsed.fault } : {}),
      isSoap: true,
      ...(attachments !== undefined ? { attachments } : {}),
    };
  } catch (cause) {
    if (cause instanceof WirebenchError && cause.code === 'not-a-soap-envelope') {
      response = { envelopeXml, isSoap: false, ...(attachments !== undefined ? { attachments } : {}) };
      problems.push({ code: 'not-soap', message: cause.message });
    } else if (cause instanceof WirebenchError && cause.code === 'xml-parse-error') {
      response = { envelopeXml, isSoap: false, ...(attachments !== undefined ? { attachments } : {}) };
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
    ...(unresolved !== undefined ? { unresolved } : {}),
  };
}
