/**
 * Sends an already-built SOAP envelope over HTTP and structurally parses the
 * response: SOAP version, fault, or "not actually SOAP" detection.
 */

import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Dispatcher } from 'undici';
import { WirebenchError } from './errors.js';
import type { HttpExchange, HttpRequest } from './http/types.js';
import { expandSendInput } from './project/properties.js';
import type { PropertyScopes, UnresolvedRef } from './project/properties.js';
import { sendWithAuth } from './http/auth/apply.js';
import { headerValue, mergeHeaders } from './http/headers.js';
import { charsetOf } from './soap/charset.js';
import {
  packageRequestBody,
  readResponseBody,
  substituteInlineFiles,
  type SoapProblem,
} from './soap/mime/send-pipeline.js';
import { parseSoapResponse } from './soap/response-parser.js';
import { soapActionHeaders } from './soap/soap-action.js';
import { applyWsaHeaders, effectiveAction } from './wsa/headers.js';
import { applyOutgoingWss } from './wss/apply.js';
import { processIncomingWss } from './wss/incoming/index.js';
import type { WssResult } from './wss/incoming/index.js';
import type { AuthSummary, SoapExchange, SoapSendInput } from './types.js';

/**
 * Sends `input.envelopeXml` to `input.endpoint` over HTTP, computing the
 * `Content-Type`/`SOAPAction` headers for `input.soapVersion` and merging in
 * any caller-supplied `input.headers`, which override the computed ones.
 *
 * HTTP-layer failures (timeout, abort, DNS, TLS, ...) propagate as
 * {@link HttpError}; a non-2xx HTTP status is not an error and is returned
 * as a normal exchange for the caller to inspect.
 *
 * When `input.attachmentOptions` is given, the envelope additionally goes through the
 * attachment pipeline. Its stages are split across the send: inline `file:` references are
 * substituted up front, with property expansion (they are envelope text, and WS-Security must
 * sign what is actually sent), while MTOM and then SwA package the finished envelope after the
 * WS-Addressing and WS-Security rewrites. A `multipart/related` response is unwrapped into its
 * envelope plus `response.attachments`. See `soap/mime/send-pipeline.ts`.
 *
 * The full request order is: property expansion → inline files → WS-Addressing → WS-Security →
 * MTOM → SwA → gzip.
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
 * actually made. A caller-supplied `Authorization` header always wins.
 *
 * When `input.auth` is NTLM, the send instead runs the three-leg NTLMv2 handshake over one
 * dedicated connection (`http/auth/ntlm-transport.ts`): a bare bodyless leg, the Type 1
 * message, then the Type 3 message carrying the real body. The returned exchange is the
 * final leg, `durationMs` sums every leg, and a server that never challenges short-circuits
 * after the first (`attempts: 1`).
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

  const problems: SoapProblem[] = [];

  // Inline `file:` references are substituted first, with property expansion: both are envelope
  // *text* preparation, and the envelope every later stage sees must be the one that goes on
  // the wire. Doing it after WS-Security — as this pipeline used to — signed the literal
  // `file:/…` text and then replaced it, leaving a signature that verifies over nothing that
  // was sent. MTOM/SwA still run last, after WSS, so the header is inside the packaged envelope.
  const inlinedEnvelopeXml = await substituteInlineFiles(effectiveInput, problems);
  if (inlinedEnvelopeXml !== effectiveInput.envelopeXml) {
    effectiveInput = { ...effectiveInput, envelopeXml: inlinedEnvelopeXml };
  }

  // WS-Addressing runs first of the envelope rewrites: before WS-Security, so a signature
  // configured to cover the `wsa:*` headers finds them already in place, and before the
  // attachment pipeline, so they are inside the envelope MTOM/SwA package and raw capture show.
  let wsaApplied: SoapExchange['wsa'] | undefined;
  const wsa = effectiveInput.wsa;
  if (wsa !== undefined && wsa.config.enabled) {
    let messageId: string | undefined;
    const uuid = wsa.uuid ?? (() => randomUUID());
    const envelopeXml = applyWsaHeaders(effectiveInput.envelopeXml, wsa.config, {
      endpoint: effectiveInput.endpoint,
      ...(effectiveInput.soapAction !== undefined ? { soapAction: effectiveInput.soapAction } : {}),
      defaultAction: wsa.defaultAction,
      uuid: () => {
        const value = uuid();
        messageId = `urn:uuid:${value}`;
        return value;
      },
      envelopeVersion: effectiveInput.soapVersion,
    });
    const action = effectiveAction(wsa.config, {
      ...(effectiveInput.soapAction !== undefined ? { soapAction: effectiveInput.soapAction } : {}),
      defaultAction: wsa.defaultAction,
    });
    // A fixed MessageID never goes through the uuid factory, so read it back off the config.
    const fixed = wsa.config.messageId;
    if (messageId === undefined && fixed !== undefined && fixed.length > 0 && fixed !== 'auto') {
      messageId = fixed;
    }
    effectiveInput = { ...effectiveInput, envelopeXml };
    wsaApplied = {
      ...(messageId !== undefined ? { messageId } : {}),
      ...(action !== undefined ? { action } : {}),
    };
  }

  // WS-Security runs on the expanded envelope and before the attachment pipeline, so the
  // header is inside the envelope that MTOM/SwA package and that raw capture records.
  let wssApplied: readonly string[] | undefined;
  const wss = effectiveInput.wss;
  if (wss?.outgoing !== undefined) {
    const envelopeXml = await applyOutgoingWss(effectiveInput.envelopeXml, wss.outgoing, wss.ctx, {
      ...(wss.requestProperties !== undefined ? { requestProperties: wss.requestProperties } : {}),
    });
    effectiveInput = { ...effectiveInput, envelopeXml };
    wssApplied = wss.outgoing.entries.map((entry) => entry.kind);
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

  // Attachments are packaged before compression, so gzip applies to the whole multipart
  // body exactly as it would to a plain envelope.
  const encoded = await packageRequestBody(effectiveInput, headers);
  // Compression is applied after the headers are merged so a caller-supplied Content-Encoding
  // cannot silently disagree with what is actually on the wire.
  const body = effectiveInput.compressBody === 'gzip' ? new Uint8Array(gzipSync(encoded)) : encoded;
  if (effectiveInput.compressBody === 'gzip') {
    headers['content-encoding'] = 'gzip';
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
    ...(effectiveInput.allowH2 !== undefined ? { allowH2: effectiveInput.allowH2 } : {}),
  };

  // Basic (preemptive or challenged) and NTLM are transport concerns, shared with the REST send.
  const authenticated = await sendWithAuth(request, effectiveInput.auth, options);
  const http: HttpExchange = authenticated.http;
  const totalDurationMs = authenticated.durationMs;

  const authSummary: AuthSummary | undefined = authenticated.auth;

  const { envelopeXml: receivedXml, attachments } = readResponseBody(
    http.body,
    headerValue(http.headers, 'content-type'),
    effectiveInput.attachmentOptions,
    problems,
  );

  // Incoming WS-Security runs on the envelope the response pipeline produced — after MTOM
  // expansion — so a signature over an expanded Body is judged over what the user sees.
  let wssIncoming: WssResult | undefined;
  let envelopeXml = receivedXml;
  if (wss?.incoming !== undefined) {
    wssIncoming = await processIncomingWss(receivedXml, wss.incoming, wss.ctx);
    if (wssIncoming.decryptedXml !== undefined) {
      envelopeXml = wssIncoming.decryptedXml;
    }
  }

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
    ...(wsaApplied !== undefined ? { wsa: wsaApplied } : {}),
    ...(wssApplied !== undefined || wssIncoming !== undefined
      ? {
          wss: {
            ...(wssApplied !== undefined ? { applied: wssApplied } : {}),
            ...(wssIncoming !== undefined ? { incoming: wssIncoming } : {}),
          },
        }
      : {}),
  };
}
