/**
 * Pure conversion helpers from engine result types (`ImportResult`, `SoapExchange`,
 * `SoapFault`) to their JSON-serialisable wire projections. Kept free of `electron` and
 * `ipcMain` imports so they can be unit-tested directly against real engine output.
 */

import { findBinding, qnameToString } from '@wirebench/engine';
import { redactHeaderPairs, redactHeaders, redactRawHttp, redactResponseAttachments, redactXml } from './redact.js';
import type {
  GeneratedRequest,
  HttpExchange,
  ImportResult,
  SoapExchange,
  SoapFault,
  SslInfo,
  ResponseAttachment,
  UnresolvedRef,
} from '@wirebench/engine';
import type {
  ExchangeSummary,
  FaultWire,
  HttpExchangeWire,
  ImportProblemWire,
  InterfaceSummary,
  OperationSummaryWire,
  RequestGenerateResponse,
  ResponseAttachmentWire,
  ServiceSummary,
  SslInfoWire,
  UnresolvedRefWire,
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
function toHttpExchangeWire(http: HttpExchange, opts?: { show?: boolean }): HttpExchangeWire {
  const show = opts?.show ?? false;
  return {
    status: http.status,
    statusText: http.statusText,
    headers: redactHeaders(http.headers, { show }),
    rawHeaders: redactHeaderPairs(http.rawHeaders, { show }),
    bodyBase64: toBase64(http.body),
    rawBodyBase64: toBase64(http.rawBody),
    rawRequestBase64: redactRawHttp(toBase64(http.rawRequest), { show, encoding: 'base64' }),
    rawResponseBase64: redactRawHttp(toBase64(http.rawResponse), { show, encoding: 'base64' }),
    truncated: http.truncated,
    ...(http.decodeError !== undefined ? { decodeError: http.decodeError } : {}),
    timings: { ...http.timings },
    redirects: http.redirects.map((redirect) => ({ ...redirect })),
    ...(http.tls !== undefined ? { tls: toTlsWire(http.tls) } : {}),
    request: {
      url: http.request.url,
      method: http.request.method,
      headers: redactHeaders(http.request.headers, { show }),
    },
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
 * Re-applies redaction to an already-built `ExchangeSummary` (the unredacted one kept by
 * `ExchangeCache`), so `exchanges.get` can answer with whatever the show-secrets flag says
 * *now* rather than what it said at send time.
 */
export function redactExchangeSummary(summary: ExchangeSummary, opts?: { show?: boolean }): ExchangeSummary {
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
      rawRequestBase64: redactRawHttp(summary.http.rawRequestBase64, { show, encoding: 'base64' }),
      rawResponseBase64: redactRawHttp(summary.http.rawResponseBase64, { show, encoding: 'base64' }),
      request: { ...summary.http.request, headers: redactHeaders(summary.http.request.headers, { show }) },
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
