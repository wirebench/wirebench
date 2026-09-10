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
import { basicAuthorization, isBasicChallenge } from './http/auth/basic.js';
import { headerValue, mergeHeaders } from './http/headers.js';
import { charsetOf } from './soap/charset.js';
import { packageRequestBody, readResponseBody, type SoapProblem } from './soap/mime/send-pipeline.js';
import { parseSoapResponse } from './soap/response-parser.js';
import { soapActionHeaders } from './soap/soap-action.js';
import type { AuthSummary, SoapExchange, SoapSendInput } from './types.js';

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
 * When `input.auth` is Basic, the `Authorization` header is either sent up front
 * (`preemptive`) or added on a single retry after the server answers the first attempt
 * with a 401 `Basic` challenge; both attempts share the one `timeoutMs` budget (if the first
 * attempt already used it all, the challenge is reported as-is, `attempts: 1`, rather than
 * firing a retry doomed to time out immediately) and the returned exchange is the final attempt
 * actually made. A caller-supplied `Authorization` header always wins, and NTLM is not
 * implemented yet (`auth-unsupported`).
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

  const auth = effectiveInput.auth;
  if (auth?.type === 'ntlm') {
    throw new WirebenchError('auth-unsupported', 'NTLM authentication lands in the next release');
  }
  // A caller-supplied Authorization header is an explicit override; never send two.
  const callerAuthorization = headerValue(headers, 'authorization') !== undefined;
  if (auth !== undefined && !callerAuthorization && auth.preemptive) {
    headers.Authorization = basicAuthorization(auth.username, auth.password);
  }

  const timeoutMs = effectiveInput.timeoutMs ?? 60_000;
  const request: HttpRequest = {
    url: effectiveInput.endpoint,
    method: 'POST',
    headers,
    body,
    timeoutMs,
    followRedirects: effectiveInput.followRedirects ?? false,
    ...(effectiveInput.maxSizeBytes !== undefined ? { maxSizeBytes: effectiveInput.maxSizeBytes } : {}),
    ...(effectiveInput.localAddress !== undefined ? { localAddress: effectiveInput.localAddress } : {}),
    ...(effectiveInput.signal !== undefined ? { signal: effectiveInput.signal } : {}),
    ...(effectiveInput.tls !== undefined ? { tls: effectiveInput.tls } : {}),
    ...(effectiveInput.proxy !== undefined ? { proxy: effectiveInput.proxy } : {}),
  };

  const now = options?.now ?? Date.now;
  const startedAt = now();
  let http = await sendHttp(request, options);
  let totalDurationMs = http.timings.totalMs;
  let challenged = false;
  let attempts: 1 | 2 = 1;
  if (auth !== undefined && !callerAuthorization && !auth.preemptive && isBasicChallenge(http)) {
    challenged = true;
    // Both attempts share one timeout budget, so a challenged send cannot take twice as long.
    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs > 0) {
      attempts = 2;
      const retryHttp = await sendHttp(
        {
          ...request,
          headers: { ...headers, Authorization: basicAuthorization(auth.username, auth.password) },
          timeoutMs: remainingMs,
        },
        options,
      );
      totalDurationMs += retryHttp.timings.totalMs;
      http = retryHttp;
    }
    // Otherwise the budget is already spent: reporting the challenge on the first (401)
    // exchange, with no retry, beats sending one doomed to time out immediately.
  }
  const authSummary: AuthSummary | undefined =
    auth !== undefined ? { scheme: 'basic', challenged, attempts } : undefined;

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
    durationMs: totalDurationMs,
    ...(authSummary !== undefined ? { auth: authSummary } : {}),
    problems,
    ...(unresolved !== undefined ? { unresolved } : {}),
  };
}
