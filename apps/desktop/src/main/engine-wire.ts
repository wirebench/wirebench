/**
 * Pure conversion helpers from engine result types (`ImportResult`, `SoapExchange`,
 * `SoapFault`) to their JSON-serialisable wire projections. Kept free of `electron` and
 * `ipcMain` imports so they can be unit-tested directly against real engine output.
 */

import { capSseRows, findBinding, qnameToString, SSE_SUMMARY_LIMITS } from '@wirebench/engine';
import {
  redactHeaderPairs,
  redactHeaders,
  redactUrl,
  redactRawHttp,
  redactResponseAttachments,
  redactSecretBytes,
  redactSecretText,
  redactXml,
} from './redact.js';
import type {
  RestContractResult,
  RestEventStream,
  RestExchange,
  GeneratedRequest,
  GrpcCallResult,
  GrpcResponseMessage,
  HttpExchange,
  ImportResult,
  SoapExchange,
  SoapFault,
  SslInfo,
  SseRow,
  ResponseAttachment,
  UnresolvedRef,
  WsExchange,
  WsFrame,
  WsFrameContract,
  WsHandshake,
} from '@wirebench/engine';
import type {
  RestEventStreamWire,
  RestContractResultWire,
  RestExchangeSummary,
  ExchangeSummary,
  FaultWire,
  GrpcExchangeSummary,
  GrpcResponseMessageWire,
  HttpExchangeWire,
  ImportProblemWire,
  InterfaceSummary,
  OperationSummaryWire,
  RequestGenerateResponse,
  ResponseAttachmentWire,
  ServiceSummary,
  SslInfoWire,
  SseRowWire,
  UnresolvedRefWire,
  WsExchangeSummary,
  WsFrameContractWire,
  WsFrameWire,
  WsHandshakeWire,
} from '../shared/wire-types.js';

/** Base name of a URL or file path (its last `/`-separated, query/fragment-free segment). */
function basenameOf(location: string): string {
  const withoutQuery = location.split(/[?#]/)[0] ?? location;
  const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
  return segments.at(-1) ?? location;
}

/** Converts an `ImportResult` plus its assigned id into the `InterfaceSummary` sent over IPC. */
export function toInterfaceSummary(result: ImportResult, id: string, definitionUrl: string): InterfaceSummary {
  const { definition } = result;

  const services: ServiceSummary[] = definition.services.map((service) => ({
    name: service.name.localName,
    ports: service.ports.map((port) => {
      const binding = findBinding(definition, port.binding);
      return {
        name: port.name,
        ...(port.address !== undefined ? { address: port.address } : {}),
        binding: qnameToString(port.binding),
        soapVersion: binding?.soapVersion ?? 'none',
      };
    }),
  }));

  const soapVersions = [...new Set(services.flatMap((service) => service.ports.map((port) => port.soapVersion)))];

  const operations: OperationSummaryWire[] = result.operations.map((op) => ({
    name: op.operationName,
    binding: qnameToString(op.bindingName),
    bindingLocal: op.bindingName.localName,
    soapVersion: op.soapVersion,
    ...(op.soapAction !== undefined ? { soapAction: op.soapAction } : {}),
    style: op.style,
    ...(op.documentation !== undefined ? { documentation: op.documentation } : {}),
    ports: op.ports.map((port) => ({
      service: port.serviceName.localName,
      port: port.portName,
      ...(port.address !== undefined ? { address: port.address } : {}),
    })),
    inputMimeParts: op.inputMimeParts.map((mimePart) => ({
      part: mimePart.part,
      ...(mimePart.type !== undefined ? { type: mimePart.type } : {}),
    })),
  }));

  const problems: ImportProblemWire[] = result.problems.map((problem) => ({
    source: problem.source,
    code: problem.code,
    message: problem.message,
    ...(problem.location !== undefined ? { location: problem.location } : {}),
    ...(problem.line !== undefined ? { line: problem.line } : {}),
    ...(problem.column !== undefined ? { column: problem.column } : {}),
  }));

  const name = definition.services[0]?.name.localName ?? basenameOf(definitionUrl);

  return {
    id,
    name,
    definitionUrl,
    targetNamespace: definition.targetNamespace,
    soapVersions,
    services,
    operations,
    problems,
    documentCount: result.bundle.documents.length,
    wsa: {
      enabled: result.wsa.enabled,
      optional: result.wsa.optional,
      version: result.wsa.version,
      defaultActionByOperation: { ...result.wsa.defaultActionByOperation },
    },
  };
}

/** Converts a `GeneratedRequest` into the `request.generate` response payload (already JSON-safe). */
export function toGenerateResponse(request: GeneratedRequest): RequestGenerateResponse {
  return {
    envelopeXml: request.envelopeXml,
    soapVersion: request.soapVersion,
    ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
    contentType: request.contentType,
    headers: { ...request.headers },
    problems: request.problems.map((problem) => ({ code: problem.code, message: problem.message })),
  };
}

/** Converts a `SoapFault` to its wire form, dropping the non-serialisable DOM `element`. */
export function toWireFault(fault: SoapFault): FaultWire {
  return {
    version: fault.version,
    code: fault.code,
    subcodes: [...fault.subcodes],
    reason: fault.reason,
    ...(fault.actor !== undefined ? { actor: fault.actor } : {}),
    ...(fault.role !== undefined ? { role: fault.role } : {}),
    ...(fault.node !== undefined ? { node: fault.node } : {}),
    ...(fault.detailXml !== undefined ? { detailXml: fault.detailXml } : {}),
  };
}

/** Base64-encodes bytes for the wire. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Copies the engine's `SslInfo` onto the wire. Deep, not a spread: `peerChain` and each
 * certificate's `sans` are `readonly` arrays in the engine and mutable ones on the wire, and
 * nothing here is secret, so no redaction applies.
 */
function toTlsWire(tls: SslInfo): SslInfoWire {
  return {
    ...(tls.protocol !== undefined ? { protocol: tls.protocol } : {}),
    ...(tls.cipher !== undefined ? { cipher: tls.cipher } : {}),
    ...(tls.authorized !== undefined ? { authorized: tls.authorized } : {}),
    ...(tls.authorizationError !== undefined ? { authorizationError: tls.authorizationError } : {}),
    ...(tls.servername !== undefined ? { servername: tls.servername } : {}),
    peerChain: tls.peerChain.map((cert) => ({
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      ...(cert.serialNumber !== undefined ? { serialNumber: cert.serialNumber } : {}),
      sans: [...cert.sans],
      fingerprint256: cert.fingerprint256,
      ...(cert.isCA !== undefined ? { isCA: cert.isCA } : {}),
    })),
    ...(tls.alpn !== undefined ? { alpn: tls.alpn } : {}),
    // DNs only — the certificate this side presented, so "did my keystore get used?" is
    // answerable in the inspector without the key ever leaving main.
    ...(tls.clientCertificate !== undefined
      ? { clientCertificate: { subject: tls.clientCertificate.subject, issuer: tls.clientCertificate.issuer } }
      : {}),
  };
}

/**
 * Converts the engine's `HttpExchange` (unredacted — this is the internal, in-memory shape) to
 * its wire form, redacting `Authorization`/`Cookie`/etc. and `wsse:Password` unless `show` is
 * set (the session "show secrets" toggle). Nothing crossing IPC carries a real secret by
 * default: the engine's own in-memory state is never touched by this.
 */
function toHttpExchangeWire(
  http: HttpExchange,
  opts?: { show?: boolean; keyParams?: readonly string[] },
): HttpExchangeWire {
  const show = opts?.show ?? false;
  // The request line carries the query, so an API key sent in it is masked there as in `url`.
  const urlOpts = { show, ...(opts?.keyParams !== undefined ? { extraParams: opts.keyParams } : {}) };
  return {
    status: http.status,
    statusText: http.statusText,
    headers: redactHeaders(http.headers, { show }),
    rawHeaders: redactHeaderPairs(http.rawHeaders, { show }),
    bodyBase64: toBase64(http.body),
    rawBodyBase64: toBase64(http.rawBody),
    rawRequestBase64: redactRawHttp(toBase64(http.rawRequest), { ...urlOpts, encoding: 'base64' }),
    rawResponseBase64: redactRawHttp(toBase64(http.rawResponse), { show, encoding: 'base64' }),
    truncated: http.truncated,
    httpVersion: http.httpVersion,
    ...(http.decodeError !== undefined ? { decodeError: http.decodeError } : {}),
    timings: { ...http.timings },
    redirects: http.redirects.map((redirect) => ({ ...redirect })),
    ...(http.tls !== undefined ? { tls: toTlsWire(http.tls) } : {}),
    request: {
      url: redactUrl(http.request.url, urlOpts),
      method: http.request.method,
      headers: redactHeaders(http.request.headers, { show }),
    },
  };
}

/**
 * Converts one engine `SseRow` to its wire form. Rows are already plain JSON; this copies field by
 * field. A server may echo a request field back, as over a WebSocket, so an event's data and a
 * comment's text have every secret value main handed out masked unless `show`.
 */
export function toSseRowWire(row: SseRow, opts?: { readonly show?: boolean }): SseRowWire {
  const show = opts?.show ?? false;
  if (row.kind === 'event') {
    return {
      kind: 'event',
      index: row.index,
      at: row.at,
      size: row.size,
      event: row.event,
      data: redactSecretText(row.data, { show }),
      ...(row.id !== undefined ? { id: row.id } : {}),
      lastEventId: row.lastEventId,
      ...(row.payloadTruncated !== undefined ? { payloadTruncated: row.payloadTruncated } : {}),
    };
  }
  if (row.kind === 'comment') {
    return {
      kind: 'comment',
      index: row.index,
      at: row.at,
      size: row.size,
      text: redactSecretText(row.text, { show }),
    };
  }
  return { kind: 'retry', index: row.index, at: row.at, size: row.size, ms: row.ms };
}

/**
 * Converts the engine's `RestEventStream` to its wire form, capping the rows to
 * `SSE_SUMMARY_LIMITS` — the same head/tail/byte-budget shape the WebSocket transcript uses — so a
 * long-running stream's summary never puts every row on the wire at once. The rows this drops were
 * already reported live, one `rest.live` `row` event each, as they arrived.
 */
export function toRestEventStreamWire(
  stream: RestEventStream,
  opts?: { readonly show?: boolean },
): RestEventStreamWire {
  const capped = capSseRows(stream.rows, SSE_SUMMARY_LIMITS);
  return {
    rows: capped.rows.map((row) => toSseRowWire(row, opts)),
    counts: { ...stream.counts },
    lastEventId: stream.lastEventId,
    ...(stream.retryMs !== undefined ? { retryMs: stream.retryMs } : {}),
    endedBy: stream.endedBy,
    ...(stream.error !== undefined ? { error: stream.error } : {}),
    droppedRows: stream.droppedRows,
    truncated: capped.truncated,
    omittedRows: capped.omittedRows,
  };
}

/** A REST response's contract result as it crosses IPC: the same fields, in mutable arrays. */
export function toRestContractWire(result: RestContractResult): RestContractResultWire {
  return {
    status: result.status,
    ...(result.operation !== undefined
      ? { operation: { method: result.operation.method, path: result.operation.path } }
      : {}),
    ...(result.responseKey !== undefined ? { responseKey: result.responseKey } : {}),
    ...(result.mediaType !== undefined ? { mediaType: result.mediaType } : {}),
    problems: result.problems.map((problem) => ({
      path: problem.path,
      keyword: problem.keyword,
      message: problem.message,
    })),
    notes: [...result.notes],
  };
}

/**
 * Converts a `RestExchange` plus its `sendId` into the `request.sendRest` response payload.
 *
 * The URL is redacted here rather than by the caller because it is the one field that can carry a
 * credential in plain sight: an API key configured to travel in the query string ends up in the URL
 * of every request that uses it. `keyParams` names the parameter that key is configured under, so a
 * key called something this build has never heard of is masked too.
 */
export function toRestExchangeSummary(
  exchange: RestExchange,
  sendId: string,
  context: { readonly method: string; readonly show?: boolean; readonly keyParams?: readonly string[] },
): RestExchangeSummary {
  const show = context.show ?? false;
  return {
    sendId,
    durationMs: exchange.durationMs,
    // A `RestExchange` *is* an `HttpExchange` with the decoded body added, so the same projection
    // the SOAP path uses applies to it directly.
    http: toHttpExchangeWire(exchange, {
      show,
      ...(context.keyParams !== undefined ? { keyParams: context.keyParams } : {}),
    }),
    url: redactUrl(exchange.request.url, {
      show,
      ...(context.keyParams !== undefined ? { extraParams: context.keyParams } : {}),
    }),
    method: context.method,
    text: exchange.text,
    language: exchange.language,
    ...(exchange.decodeNote !== undefined ? { decodeNote: exchange.decodeNote } : {}),
    cookies: exchange.cookies.map((cookie) => ({ ...cookie })),
    methodChanged: exchange.methodChanged,
    problems: [],
    ...(exchange.auth !== undefined
      ? {
          auth: {
            scheme: exchange.auth.scheme,
            challenged: exchange.auth.challenged,
            attempts: exchange.auth.attempts,
          },
        }
      : {}),
    ...(exchange.stream !== undefined ? { stream: toRestEventStreamWire(exchange.stream, { show }) } : {}),
  };
}

/**
 * Converts one gRPC call's result plus its `sendId` into the `request.sendGrpc` response payload.
 *
 * The `http` projection is synthesised from the HTTP/2 exchange the call was: the same headers,
 * raw bytes, timings and TLS the other protocols report, with the decoded response messages as the
 * body so the HTTP log's size column and the status bar mean the same thing they do for a REST send.
 * Metadata is redacted as headers are — `authorization` is `authorization` on any protocol.
 */
/**
 * One decoded response message on the wire. Shared by the finished exchange and by the live
 * events a call in flight emits, so a message looks the same whichever way the pane met it.
 *
 * A server may echo a request field back, so every secret value main handed out is masked unless
 * `show`: in the JSON, or in the raw bytes when there is no JSON. The pane shows the bytes only for
 * a message that did not decode, so a decoded message's are left as they are rather than scanned
 * for nothing. `bytes` stays the size the server sent, as a WebSocket frame's `size` does.
 */
export function toGrpcResponseMessageWire(
  message: GrpcResponseMessage,
  opts?: { readonly show?: boolean },
): GrpcResponseMessageWire {
  const show = opts?.show ?? false;
  const json =
    message.json !== undefined ? redactSecretText(JSON.stringify(message.json, null, 2), { show }) : undefined;
  return {
    ...(json !== undefined ? { json } : {}),
    // Masking can change the length: `bytes` stays the size the server sent, these are for display.
    base64: redactSecretBytes(message.base64, { show }),
    bytes: message.bytes,
    ...(message.problem !== undefined ? { problem: message.problem } : {}),
  };
}

export function toGrpcExchangeSummary(
  result: GrpcCallResult,
  sendId: string,
  context: { readonly show?: boolean },
): GrpcExchangeSummary {
  const show = context.show ?? false;
  const exchange = result.exchange;
  const responseMessages = result.responseMessages.map((message) => toGrpcResponseMessageWire(message, { show }));
  const bodyText = responseMessages.map((message) => message.json ?? message.base64).join('\n');
  const http: HttpExchangeWire = {
    status: exchange.httpStatus,
    statusText: exchange.statusName,
    headers: redactHeaders(exchange.headers, { show }),
    rawHeaders: redactHeaderPairs(Object.entries(exchange.headers), { show }),
    bodyBase64: toBase64(Buffer.from(bodyText, 'utf8')),
    // Masked for display, so its length can differ from the sum of the messages' `bytes`, which stay
    // the sizes the server sent.
    rawBodyBase64: redactSecretBytes(
      toBase64(exchange.messages.reduce<Uint8Array>((all, one) => Buffer.concat([all, one]), new Uint8Array())),
      { show },
    ),
    rawRequestBase64: redactRawHttp(toBase64(exchange.rawRequest), { show, encoding: 'base64' }),
    rawResponseBase64: redactRawHttp(toBase64(exchange.rawResponse), { show, encoding: 'base64' }),
    truncated: exchange.truncated,
    httpVersion: '2',
    timings: { ...exchange.timings },
    redirects: [],
    ...(exchange.tls !== undefined ? { tls: toTlsWire(exchange.tls) } : {}),
    request: {
      url: `${exchange.request.headers[':scheme'] ?? 'http'}://${exchange.request.authority}${exchange.request.path}`,
      method: 'POST',
      headers: redactHeaders(
        Object.fromEntries(Object.entries(exchange.request.headers).filter(([name]) => !name.startsWith(':'))),
        { show },
      ),
    },
  };
  return {
    sendId,
    durationMs: exchange.durationMs,
    http,
    target: exchange.request.authority,
    service: result.requestType === '' ? '' : (exchange.request.path.split('/')[1] ?? ''),
    method: exchange.request.path.split('/')[2] ?? '',
    methodKind: result.methodKind,
    status: exchange.status,
    statusName: exchange.statusName,
    // The server's own text, which may echo a request field as a message can.
    ...(exchange.statusMessage !== undefined
      ? { statusMessage: redactSecretText(exchange.statusMessage, { show }) }
      : {}),
    statusSource: exchange.statusSource,
    headers: redactHeaders(exchange.headers, { show }),
    trailers: redactHeaders(exchange.trailers, { show }),
    // A request message may carry a `${secret:name}` value the send resolved into it.
    requestMessages: result.requestMessages.map((message) =>
      redactSecretText(JSON.stringify(message, null, 2), { show }),
    ),
    responseMessages,
    ...(exchange.encoding !== undefined ? { encoding: exchange.encoding } : {}),
    truncated: exchange.truncated,
    problems: [],
  };
}

/** A frame's contract check result onto the wire. */
export function toWsFrameContractWire(contract: WsFrameContract): WsFrameContractWire {
  return {
    status: contract.status,
    ...(contract.message !== undefined ? { message: contract.message } : {}),
    ...(contract.problems !== undefined ? { problems: contract.problems.map((problem) => ({ ...problem })) } : {}),
    ...(contract.reason !== undefined ? { reason: contract.reason } : {}),
  };
}

/**
 * Converts one engine `WsFrame` to its wire form. No pattern rule applies to a payload, but a text
 * payload has every secret value main handed out masked unless `show` — a message's own
 * `${secret:name}` token, and the same value echoed back. So do a binary payload's bytes, whatever
 * encoding surrounds the value, and a close frame's reason.
 */
export function toWsFrameWire(frame: WsFrame, opts?: { readonly show?: boolean }): WsFrameWire {
  const show = opts?.show ?? false;
  return {
    index: frame.index,
    direction: frame.direction,
    opcode: frame.opcode,
    at: frame.at,
    size: frame.size,
    ...(frame.text !== undefined ? { text: redactSecretText(frame.text, { show }) } : {}),
    // Masking can change a payload's length; `size` stays its size on the wire.
    ...(frame.base64 !== undefined ? { base64: redactSecretBytes(frame.base64, { show }) } : {}),
    ...(frame.close !== undefined
      ? { close: { code: frame.close.code, reason: redactSecretText(frame.close.reason, { show }) } }
      : {}),
    ...(frame.payloadTruncated !== undefined ? { payloadTruncated: frame.payloadTruncated } : {}),
    ...(frame.contract !== undefined ? { contract: toWsFrameContractWire(frame.contract) } : {}),
  };
}

/**
 * Converts one engine `WsHandshake` to its wire form, header values redacted unless `show` — the
 * same redactor and the same switch `toGrpcExchangeSummary` uses. `rawRequestHead` carries the
 * same header lines as `requestHeaders`, so it is redacted line-by-line with `redactRawHttp`'s
 * `encoding: 'text'` mode rather than dropped.
 *
 * `url` is redacted too, the same way a REST exchange's `url` is (`toRestExchangeSummary`): an
 * API key configured "in query" lives in the URL itself, not in a header, so a header-only
 * redaction would leak it into every `ws.live` handshake event and the final summary alike.
 * `opts.keyParams` names the query parameter(s) to mask regardless of what they are called.
 */
export function toWsHandshakeWire(
  handshake: WsHandshake,
  opts?: { readonly show?: boolean; readonly keyParams?: readonly string[] },
): WsHandshakeWire {
  const show = opts?.show ?? false;
  return {
    url: redactUrl(handshake.url, { show, ...(opts?.keyParams !== undefined ? { extraParams: opts.keyParams } : {}) }),
    requestHeaders: redactHeaders(handshake.requestHeaders, { show }),
    requestedSubprotocols: [...handshake.requestedSubprotocols],
    ...(handshake.rawRequestHead !== undefined
      ? { rawRequestHead: redactRawHttp(handshake.rawRequestHead, { show, encoding: 'text' }) }
      : {}),
    ...(handshake.status !== undefined ? { status: handshake.status } : {}),
    ...(handshake.statusText !== undefined ? { statusText: handshake.statusText } : {}),
    ...(handshake.responseHeaders !== undefined
      ? { responseHeaders: redactHeaders(handshake.responseHeaders, { show }) }
      : {}),
    ...(handshake.protocol !== undefined ? { protocol: handshake.protocol } : {}),
    ...(handshake.extensions !== undefined ? { extensions: handshake.extensions } : {}),
    ...(handshake.remoteAddress !== undefined ? { remoteAddress: handshake.remoteAddress } : {}),
    startedAt: handshake.startedAt,
    durationMs: handshake.durationMs,
    ...(handshake.tls !== undefined ? { tls: toTlsWire(handshake.tls) } : {}),
    ...(handshake.error !== undefined ? { error: handshake.error } : {}),
  };
}

/**
 * Converts one engine `WsExchange` plus its `sendId` into the `request.openWs` response payload.
 * `opts.keyParams` masks the same query parameter(s) in both `url` (this exchange's) and the
 * handshake's own `url` — see {@link toWsHandshakeWire}.
 */
export function toWsExchangeSummary(
  exchange: WsExchange,
  sendId: string,
  opts?: { readonly show?: boolean; readonly keyParams?: readonly string[] },
): WsExchangeSummary {
  return {
    sendId,
    url: redactUrl(exchange.url, {
      show: opts?.show ?? false,
      ...(opts?.keyParams !== undefined ? { extraParams: opts.keyParams } : {}),
    }),
    handshake: toWsHandshakeWire(exchange.handshake, opts),
    frames: exchange.frames.map((frame) => toWsFrameWire(frame, opts)),
    // The server's close reason may echo a request field, as a frame's payload may.
    closed: { ...exchange.closed, reason: redactSecretText(exchange.closed.reason, { show: opts?.show ?? false }) },
    counts: { ...exchange.counts },
    durationMs: exchange.durationMs,
  };
}

/**
 * Copies an engine `UnresolvedRef` onto the wire. `field`/`headerName` are left absent: the
 * engine expands the whole send input at once and does not record which part a ref came from
 * (`request.preflight` does — see `expansion-preflight.ts`).
 */
export function toUnresolvedRefWire(ref: UnresolvedRef): UnresolvedRefWire {
  return {
    expr: ref.expr,
    ...(ref.scope !== undefined ? { scope: ref.scope } : {}),
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    code: ref.code,
    start: ref.start,
    end: ref.end,
    ...(ref.via !== undefined ? { via: [...ref.via] } : {}),
  };
}

/**
 * Lists a response's attachment parts for the renderer: metadata only, indexed by position, so
 * the bytes stay in main (`ExchangeCache`) and reach disk only through `attachments.saveResponse`.
 * Routed through `redactResponseAttachments` for the same reason headers are — a future
 * `Content-Disposition` carrying a token has one place to be masked.
 *
 * `opts.show` is honoured like every other field's: this same builder fills the unredacted
 * master copy the `ExchangeCache` keeps (`toExchangeSummary(..., { show: true })`), and masking
 * that copy would make the masking irreversible — `exchanges.get` could never un-hide it again.
 */
export function toResponseAttachmentWires(
  attachments: readonly ResponseAttachment[] | undefined,
  opts?: { show?: boolean },
): ResponseAttachmentWire[] {
  if (attachments === undefined) {
    return [];
  }
  const wires = attachments.map((attachment, index) => ({
    index,
    contentId: attachment.contentId,
    contentType: attachment.contentType,
    size: attachment.size,
    ...(attachment.name !== undefined ? { name: attachment.name } : {}),
  }));
  return opts?.show === true ? wires : redactResponseAttachments(wires);
}

/** Converts a `SoapExchange` plus its `sendId` into the `request.send` response payload. */
export function toExchangeSummary(exchange: SoapExchange, sendId: string, opts?: { show?: boolean }): ExchangeSummary {
  return {
    sendId,
    durationMs: exchange.durationMs,
    http: toHttpExchangeWire(exchange.http, opts),
    ...(exchange.response !== undefined
      ? {
          response: {
            envelopeXml: exchange.response.envelopeXml,
            ...(exchange.response.version !== undefined ? { version: exchange.response.version } : {}),
            isSoap: exchange.response.isSoap,
            ...(exchange.response.fault !== undefined ? { fault: toWireFault(exchange.response.fault) } : {}),
            attachments: toResponseAttachmentWires(exchange.response.attachments, opts),
          },
        }
      : {}),
    problems: exchange.problems.map((problem) => ({ code: problem.code, message: problem.message })),
    ...(exchange.auth !== undefined
      ? {
          auth: {
            scheme: exchange.auth.scheme,
            challenged: exchange.auth.challenged,
            attempts: exchange.auth.attempts,
          },
        }
      : {}),
    ...(exchange.unresolved !== undefined ? { unresolved: exchange.unresolved.map(toUnresolvedRefWire) } : {}),
    ...(exchange.wsa !== undefined
      ? {
          wsa: {
            ...(exchange.wsa.messageId !== undefined ? { messageId: exchange.wsa.messageId } : {}),
            ...(exchange.wsa.action !== undefined ? { action: exchange.wsa.action } : {}),
          },
        }
      : {}),
    // Only booleans, details and subjects cross the bridge: `WssResult` is already free of key
    // material by construction, and this mapping keeps it that way field by field.
    ...(exchange.wss !== undefined
      ? {
          wss: {
            ...(exchange.wss.applied !== undefined ? { applied: [...exchange.wss.applied] } : {}),
            ...(exchange.wss.incoming !== undefined
              ? {
                  incoming: {
                    actions: exchange.wss.incoming.actions.map((action) => ({
                      kind: action.kind,
                      ok: action.ok,
                      detail: action.detail,
                      ...(action.signerSubject !== undefined ? { signerSubject: action.signerSubject } : {}),
                      ...(action.trusted !== undefined ? { trusted: action.trusted } : {}),
                      ...(action.created !== undefined ? { created: action.created } : {}),
                      ...(action.expires !== undefined ? { expires: action.expires } : {}),
                      ...(action.references !== undefined ? { references: [...action.references] } : {}),
                      ...(action.coversBody !== undefined ? { coversBody: action.coversBody } : {}),
                    })),
                    errors: [...exchange.wss.incoming.errors],
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Masks `keyParams` in the request line of raw request bytes (`POST /calc?key=… HTTP/1.1`), which
 * `redactRawHttp` leaves alone because it reads headers, not the target. A no-op without
 * `keyParams`, so an exchange with no query API key keeps its bytes exactly as sent.
 */
function redactRequestTarget(rawBase64: string, keyParams: readonly string[]): string {
  if (keyParams.length === 0) {
    return rawBase64;
  }
  const raw = Buffer.from(rawBase64, 'base64');
  const end = raw.indexOf('\r\n');
  if (end < 0) {
    return rawBase64;
  }
  const line = raw.subarray(0, end).toString('latin1');
  const match = /^(\S+) (\S+) (\S+)$/.exec(line);
  if (match === null || !match[2]!.includes('?')) {
    return rawBase64;
  }
  const target = maskTarget(match[2]!, keyParams);
  return Buffer.concat([Buffer.from(`${match[1]!} ${target} ${match[3]!}`, 'latin1'), raw.subarray(end)]).toString(
    'base64',
  );
}

/**
 * One request target with `keyParams` masked. An origin-form target (`/calc?key=…`) is parsed
 * under a placeholder origin and rebuilt from the parsed path and query, never by trimming a
 * string prefix; an absolute-form one is a URL already. Returned as sent when nothing is masked.
 */
function maskTarget(target: string, keyParams: readonly string[]): string {
  const options = { show: false, extraParams: keyParams };
  if (!target.startsWith('/')) {
    return redactUrl(target, options);
  }
  // Prefixed rather than resolved, so a path that starts `//` stays a path, not a host.
  const placed = `http://request.invalid${target}`;
  const redacted = redactUrl(placed, options);
  if (redacted === placed) {
    return target;
  }
  const parsed = new URL(redacted);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Re-applies redaction to an already-built `ExchangeSummary` (the unredacted one kept by
 * `ExchangeCache`), so `exchanges.get` can answer with whatever the show-secrets flag says
 * *now* rather than what it said at send time.
 */
export function redactExchangeSummary(
  summary: ExchangeSummary,
  opts?: { show?: boolean; readonly keyParams?: readonly string[] },
): ExchangeSummary {
  const show = opts?.show ?? false;
  if (show) {
    return summary;
  }
  return {
    ...summary,
    http: {
      ...summary.http,
      headers: redactHeaders(summary.http.headers, { show }),
      rawHeaders: redactHeaderPairs(summary.http.rawHeaders, { show }),
      rawRequestBase64: redactRequestTarget(
        redactRawHttp(summary.http.rawRequestBase64, { show, encoding: 'base64' }),
        opts?.keyParams ?? [],
      ),
      rawResponseBase64: redactRawHttp(summary.http.rawResponseBase64, { show, encoding: 'base64' }),
      // The first hop is the wire URL, which carries a query API key as the request URL does.
      redirects: summary.http.redirects.map((redirect) => ({
        ...redirect,
        url: redactUrl(redirect.url, { show, extraParams: opts?.keyParams ?? [] }),
      })),
      request: {
        ...summary.http.request,
        // A SOAP owner's API key may travel in the query string; `keyParams` names it whatever it is
        // called, as on a REST send.
        url: redactUrl(summary.http.request.url, { show, extraParams: opts?.keyParams ?? [] }),
        headers: redactHeaders(summary.http.request.headers, { show }),
      },
    },
    ...(summary.response !== undefined
      ? {
          response: {
            ...summary.response,
            attachments: redactResponseAttachments(summary.response.attachments),
            envelopeXml: redactXml(summary.response.envelopeXml, { show }),
            ...(summary.response.fault !== undefined
              ? {
                  fault: {
                    ...summary.response.fault,
                    ...(summary.response.fault.detailXml !== undefined
                      ? { detailXml: redactXml(summary.response.fault.detailXml, { show }) }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
