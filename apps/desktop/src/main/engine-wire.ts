/**
 * Pure conversion helpers from engine result types (`ImportResult`, `SoapExchange`,
 * `SoapFault`) to their JSON-serialisable wire projections. Kept free of `electron` and
 * `ipcMain` imports so they can be unit-tested directly against real engine output.
 */

import { findBinding, qnameToString } from '@wirebench/engine';
import { redactHeaders, redactRawHttp } from './redact.js';
import type {
  GeneratedRequest,
  HttpExchange,
  ImportResult,
  SoapExchange,
  SoapFault,
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
  ServiceSummary,
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
    rawHeaders: http.rawHeaders.map(([name, value]) => [name, value]),
    bodyBase64: toBase64(http.body),
    rawBodyBase64: toBase64(http.rawBody),
    rawRequestBase64: redactRawHttp(toBase64(http.rawRequest), { show, encoding: 'base64' }),
    rawResponseBase64: redactRawHttp(toBase64(http.rawResponse), { show, encoding: 'base64' }),
    truncated: http.truncated,
    ...(http.decodeError !== undefined ? { decodeError: http.decodeError } : {}),
    timings: { ...http.timings },
    redirects: http.redirects.map((redirect) => ({ ...redirect })),
    ...(http.tls !== undefined ? { tls: { ...http.tls } } : {}),
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
          },
        }
      : {}),
    problems: exchange.problems.map((problem) => ({ code: problem.code, message: problem.message })),
    ...(exchange.unresolved !== undefined ? { unresolved: exchange.unresolved.map(toUnresolvedRefWire) } : {}),
  };
}
