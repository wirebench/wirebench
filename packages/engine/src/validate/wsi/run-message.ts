/**
 * Runs the WS-I Basic Profile 1.1 message assertion catalogue over one {@link SoapExchange}.
 *
 * Where `run-wsdl.ts` judges a *description*, this judges the bytes one send actually put on the
 * wire — both halves of it. The report shape is the same {@link WsiReport}, so a single renderer
 * (and a single HTML export) serves both.
 */

import type { Document, Element } from '@xmldom/xmldom';
import { NS } from '../../xml/namespaces.js';
import { parseXml } from '../../xml/parse.js';
import type { SoapExchange } from '../../types.js';
import type { WsdlDefinition } from '../../wsdl/model.js';
import { findBinding } from '../../wsdl/model.js';
import type { OperationRef } from '../../soap/request-builder.js';
import { WSI_MESSAGE_ASSERTIONS } from './assertions/message/index.js';
import type {
  WsiAssertionReport,
  WsiAssertionResult,
  WsiMessageAssertion,
  WsiMessageBinding,
  WsiMessageContext,
  WsiMessageDirection,
  WsiMessageView,
  WsiReport,
  WsiSummary,
} from './types.js';
import { isNotApplicable } from './types.js';

/** The two envelope namespaces a message may legally use, mapped to their SOAP version. */
const ENVELOPE_VERSIONS: readonly (readonly [string, '1.1' | '1.2'])[] = [
  [NS.SOAP11_ENV, '1.1'],
  [NS.SOAP12_ENV, '1.2'],
];

/** Parses one half's envelope, tolerating text that is not XML at all. */
function parsed(text: string | undefined): Document | undefined {
  if (text === undefined || text.trim().length === 0) {
    return undefined;
  }
  try {
    return parseXml(text);
  } catch {
    // Not well-formed: R1001 reports it, and every DOM-based assertion reports notApplicable.
    return undefined;
  }
}

/** The document element when it is a `soap:Envelope` in either SOAP envelope namespace. */
function envelopeOf(document: Document | undefined): { element: Element; soapNs: string } | undefined {
  const root = document?.documentElement ?? null;
  if (root === null || root.localName !== 'Envelope') {
    return undefined;
  }
  const match = ENVELOPE_VERSIONS.find(([uri]) => uri === root.namespaceURI);
  return match === undefined ? undefined : { element: root, soapNs: match[0] };
}

/** Lower-cases every header name, so an assertion can index by the name it expects. */
function lowerCased(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** Builds one half's view: HTTP metadata plus the parsed envelope, when there is one. */
function viewFor(
  direction: WsiMessageDirection,
  headers: Readonly<Record<string, string>>,
  envelopeXml: string | undefined,
  status?: number,
): WsiMessageView {
  const document = parsed(envelopeXml);
  const envelope = envelopeOf(document);
  return {
    direction,
    headers: lowerCased(headers),
    ...(envelopeXml !== undefined ? { envelopeXml } : {}),
    ...(document !== undefined ? { document } : {}),
    ...(envelope !== undefined ? { envelope: envelope.element, soapNs: envelope.soapNs } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/** What {@link runMessageAssertions} needs besides the exchange itself. */
export interface RunMessageAssertionsOptions {
  /** What the binding says about this operation's messages. */
  readonly binding: WsiMessageBinding;
  /** Which half the caller asked about; both are still analysed. */
  readonly direction: WsiMessageDirection;
  /**
   * The request envelope text. `SoapExchange` keeps the request only as raw wire bytes, so a
   * caller that still holds the envelope it sent should pass it rather than making this module
   * re-split the HTTP frame.
   */
  readonly requestEnvelopeXml?: string;
  /** Run only these assertion ids (default: the whole catalogue). */
  readonly ids?: readonly string[];
  /** Include `passed`/`notApplicable` rows in `assertions` (the `wsi.verbose` preference). */
  readonly verbose?: boolean;
}

/** The text after the first blank line of a reconstructed HTTP frame — its entity body. */
function bodyOfFrame(raw: Uint8Array | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  const separator = /\r?\n\r?\n/.exec(text);
  if (separator === null || separator.index === undefined) {
    return undefined;
  }
  const body = text.slice(separator.index + separator[0].length);
  return body.length === 0 ? undefined : body;
}

/** Builds the context the message assertions run against. */
export function wsiMessageContext(exchange: SoapExchange, options: RunMessageAssertionsOptions): WsiMessageContext {
  const request = viewFor(
    'request',
    exchange.http.request.headers,
    options.requestEnvelopeXml ?? bodyOfFrame(exchange.http.rawRequest),
  );
  const response =
    exchange.response === undefined && exchange.http.rawResponse.length === 0
      ? undefined
      : viewFor('response', exchange.http.headers, exchange.response?.envelopeXml, exchange.http.status);
  return {
    exchange,
    binding: options.binding,
    direction: options.direction,
    request,
    ...(response !== undefined ? { response } : {}),
    messages: response === undefined ? [request] : [request, response],
  };
}

/** Classifies one assertion's outcome; the mapping matches `run-wsdl.ts` exactly. */
function resultFor(assertion: WsiMessageAssertion, context: WsiMessageContext): WsiAssertionReport {
  const outcome = assertion.check(context);
  const findings = isNotApplicable(outcome) ? [] : outcome;
  let result: WsiAssertionResult;
  if (isNotApplicable(outcome)) {
    result = 'notApplicable';
  } else if (findings.length === 0) {
    result = 'passed';
  } else {
    result = assertion.level === 'REQUIRED' ? 'failed' : 'warning';
  }
  return {
    id: assertion.id,
    title: assertion.title,
    level: assertion.level,
    section: assertion.section,
    result,
    findings,
  };
}

/**
 * Evaluates the message assertion catalogue against one exchange.
 *
 * `summary` always counts every assertion that ran; `assertions` carries only the failing rows
 * unless `verbose` is set. `target` names the endpoint the exchange went to, so a report can say
 * what it is about without the caller re-deriving it.
 *
 * @param exchange the send to analyse, request and response alike
 * @param options the binding facts, the half the caller asked about, and the usual id/verbose knobs
 */
export function runMessageAssertions(exchange: SoapExchange, options: RunMessageAssertionsOptions): WsiReport {
  const context = wsiMessageContext(exchange, options);
  const selected =
    options.ids === undefined
      ? WSI_MESSAGE_ASSERTIONS
      : WSI_MESSAGE_ASSERTIONS.filter((assertion) => options.ids?.includes(assertion.id) === true);

  const reports = selected.map((assertion) => resultFor(assertion, context));
  const summary: WsiSummary = {
    passed: reports.filter((report) => report.result === 'passed').length,
    failed: reports.filter((report) => report.result === 'failed').length,
    warning: reports.filter((report) => report.result === 'warning').length,
    notApplicable: reports.filter((report) => report.result === 'notApplicable').length,
  };

  return {
    target: exchange.http.request.url,
    profile: 'BP1.1',
    summary,
    assertions:
      options.verbose === true
        ? reports
        : reports.filter((report) => report.result === 'failed' || report.result === 'warning'),
  };
}

/**
 * Derives the {@link WsiMessageBinding} one operation implies, so a caller holding an
 * `ImportResult` does not have to walk the model itself. Returns `undefined` when the binding is
 * not a SOAP binding, or has no such operation.
 *
 * @param definition the merged description
 * @param op the binding and operation the message belongs to
 */
export function messageBindingFor(definition: WsdlDefinition, op: OperationRef): WsiMessageBinding | undefined {
  const binding = findBinding(definition, op.bindingName);
  if (binding === undefined || binding.soapVersion === 'none') {
    return undefined;
  }
  const operation = binding.operations.find((candidate) => candidate.name === op.operationName);
  if (operation === undefined) {
    return undefined;
  }
  // The input side states the `use` for the request; a binding that differed between the two
  // halves would be out of profile anyway (R2706), so the output is only the fallback.
  const use = operation.input?.body.use ?? operation.output?.body.use ?? 'literal';
  return {
    soapVersion: binding.soapVersion,
    style: operation.style ?? binding.style,
    use,
    operation: op.operationName,
    ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
  };
}
