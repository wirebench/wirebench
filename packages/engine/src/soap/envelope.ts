/**
 * SOAP envelope assembly: wraps already-rendered header and body fragments in
 * a `soapenv:Envelope`, matching SoapUI's output conventions (three-space
 * indent, `soapenv` prefix, an always-present `Header`).
 */

import type { Document } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import { escapeAttribute } from '../xsd/xml-writer.js';

/** The SOAP version an envelope is written in. */
export type SoapEnvelopeVersion = '1.1' | '1.2';

/** The prefix every generated envelope binds its SOAP envelope namespace to. */
export const SOAP_ENVELOPE_PREFIX = 'soapenv';

/** The pieces {@link createEnvelope} wraps. */
export interface EnvelopeParts {
  /** Already-rendered header block children; omitted or empty yields `<soapenv:Header/>`. */
  readonly headerXml?: string;
  /** Already-rendered body children; empty yields `<soapenv:Body/>`. */
  readonly bodyXml: string;
  /** Extra prefix → namespace URI declarations to hoist onto the `Envelope` element. */
  readonly namespaces?: Readonly<Record<string, string>>;
}

/** The SOAP envelope namespace URI for `version`. */
export function envelopeNamespace(version: SoapEnvelopeVersion): string {
  return version === '1.2' ? NS.SOAP12_ENV : NS.SOAP11_ENV;
}

/**
 * The SOAP version of a parsed document, from its root element's namespace, or
 * `undefined` when the root is not a SOAP `Envelope`.
 */
export function detectEnvelopeVersion(doc: Document): SoapEnvelopeVersion | undefined {
  const root = doc.documentElement;
  if (root === null || root.localName !== 'Envelope') {
    return undefined;
  }
  if (root.namespaceURI === NS.SOAP11_ENV) {
    return '1.1';
  }
  return root.namespaceURI === NS.SOAP12_ENV ? '1.2' : undefined;
}

/** Prepends `pad` to every non-empty line of `text`. */
function indentBlock(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join('\n');
}

/**
 * Wraps `parts` in a SOAP envelope.
 *
 * The `Header` element is always emitted (empty when there are no header
 * blocks), mirroring SoapUI: it gives the user somewhere to paste a security
 * header without re-typing the element. Every namespace in
 * {@link EnvelopeParts.namespaces} is declared on the `Envelope` root, so the
 * fragments inside carry no `xmlns` declarations of their own.
 *
 * Deterministic: identical inputs always produce byte-identical output.
 *
 * @param version which SOAP envelope namespace to bind
 * @param parts the header/body fragments and the namespaces they use
 * @param options `indent` defaults to three spaces (SoapUI's)
 */
export function createEnvelope(
  version: SoapEnvelopeVersion,
  parts: EnvelopeParts,
  options?: { readonly indent?: string },
): string {
  const indent = options?.indent ?? '   ';
  const declarations = [
    `xmlns:${SOAP_ENVELOPE_PREFIX}="${escapeAttribute(envelopeNamespace(version))}"`,
    ...Object.entries(parts.namespaces ?? {}).map(([prefix, uri]) => `xmlns:${prefix}="${escapeAttribute(uri)}"`),
  ];
  const lines: string[] = [`<${SOAP_ENVELOPE_PREFIX}:Envelope ${declarations.join(' ')}>`];
  const header = parts.headerXml?.trim() ?? '';
  if (header.length === 0) {
    lines.push(`${indent}<${SOAP_ENVELOPE_PREFIX}:Header/>`);
  } else {
    lines.push(`${indent}<${SOAP_ENVELOPE_PREFIX}:Header>`);
    lines.push(indentBlock(parts.headerXml ?? '', indent.repeat(2)));
    lines.push(`${indent}</${SOAP_ENVELOPE_PREFIX}:Header>`);
  }
  if (parts.bodyXml.trim().length === 0) {
    lines.push(`${indent}<${SOAP_ENVELOPE_PREFIX}:Body/>`);
  } else {
    lines.push(`${indent}<${SOAP_ENVELOPE_PREFIX}:Body>`);
    lines.push(indentBlock(parts.bodyXml, indent.repeat(2)));
    lines.push(`${indent}</${SOAP_ENVELOPE_PREFIX}:Body>`);
  }
  lines.push(`</${SOAP_ENVELOPE_PREFIX}:Envelope>`);
  return lines.join('\n');
}
