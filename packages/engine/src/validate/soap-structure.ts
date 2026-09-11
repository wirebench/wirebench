/**
 * SOAP envelope structure checks — everything the XSD schema set cannot say
 * about a message, because the envelope itself is never validated against it:
 * the envelope namespace (and therefore the SOAP version), the
 * `Header`/`Body` shape, the `Fault` shape, `mustUnderstand` values, and the
 * agreement between the transport metadata (`Content-Type`, `SOAPAction`) and
 * the version in the envelope.
 *
 * Tolerant by design: a document that is not well formed yields exactly one
 * `xml-not-well-formed` problem (with the parser's position) instead of
 * throwing, so a half-typed envelope still produces a usable marker.
 */

import type { Element, Node } from '@xmldom/xmldom';
import { WirebenchError } from '../errors.js';
import { NS } from '../xml/namespaces.js';
import { parseXml, getPosition } from '../xml/parse.js';
import type { SoapEnvelopeVersion } from '../soap/envelope.js';
import type { ValidationProblem } from './types.js';

/** What {@link checkSoapStructure} compares the message against. */
export interface SoapStructureOptions {
  /** The SOAP version the binding declares; an envelope in the other version's namespace is an error. */
  readonly expectedVersion: SoapEnvelopeVersion;
  /** The `SOAPAction` the request sends (1.1) or the action the binding declares (1.2). */
  readonly soapAction?: string;
  /** The `Content-Type` header the message is sent with (or was received with). */
  readonly contentType?: string;
}

/** The envelope namespace URI for each SOAP version. */
const ENVELOPE_NS: Readonly<Record<SoapEnvelopeVersion, string>> = {
  '1.1': NS.SOAP11_ENV,
  '1.2': NS.SOAP12_ENV,
};

/** The `Content-Type` media type each SOAP version prescribes. */
const MEDIA_TYPE: Readonly<Record<SoapEnvelopeVersion, string>> = {
  '1.1': 'text/xml',
  '1.2': 'application/soap+xml',
};

/** Legal `mustUnderstand` values per version: 1.1 allows only `0`/`1`, 1.2 takes any `xs:boolean`. */
const MUST_UNDERSTAND_VALUES: Readonly<Record<SoapEnvelopeVersion, readonly string[]>> = {
  '1.1': ['0', '1'],
  '1.2': ['0', '1', 'true', 'false'],
};

/** Builds a problem, folding in the source position of `element` when it has one. */
function at(
  element: Element | undefined,
  problem: Omit<ValidationProblem, 'source' | 'line' | 'column'>,
): ValidationProblem {
  const position = element === undefined ? undefined : getPosition(element);
  return {
    ...problem,
    source: 'structure',
    ...(position !== undefined ? { line: position.line, column: position.column } : {}),
  };
}

/** The direct child elements of `parent`, in document order. */
function elementChildren(parent: Element): Element[] {
  const result: Element[] = [];
  let child: Node | null = parent.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      result.push(child as Element);
    }
    child = child.nextSibling;
  }
  return result;
}

/** True when `element` has a child element with `localName` in `namespaceUri` that is not empty. */
function hasChild(element: Element, namespaceUri: string | undefined, localName: string): boolean {
  return elementChildren(element).some(
    (child) => child.localName === localName && (namespaceUri === undefined || child.namespaceURI === namespaceUri),
  );
}

/** The `Fault` checks for one version; the shapes differ enough that they share nothing but the name. */
function checkFault(fault: Element, version: SoapEnvelopeVersion, problems: ValidationProblem[]): void {
  if (version === '1.1') {
    // SOAP 1.1 Fault children are unqualified.
    if (!hasChild(fault, undefined, 'faultcode')) {
      problems.push(
        at(fault, { severity: 'error', code: 'fault-missing-faultcode', message: 'SOAP 1.1 Fault has no <faultcode>' }),
      );
    }
    if (!hasChild(fault, undefined, 'faultstring')) {
      problems.push(
        at(fault, {
          severity: 'error',
          code: 'fault-missing-faultstring',
          message: 'SOAP 1.1 Fault has no <faultstring>',
        }),
      );
    }
    return;
  }
  const code = elementChildren(fault).find((child) => child.localName === 'Code');
  if (code === undefined || !hasChild(code, NS.SOAP12_ENV, 'Value')) {
    problems.push(
      at(fault, { severity: 'error', code: 'fault-missing-code', message: 'SOAP 1.2 Fault has no <Code><Value>' }),
    );
  }
  const reason = elementChildren(fault).find((child) => child.localName === 'Reason');
  if (reason === undefined || !hasChild(reason, NS.SOAP12_ENV, 'Text')) {
    problems.push(
      at(fault, { severity: 'error', code: 'fault-missing-reason', message: 'SOAP 1.2 Fault has no <Reason><Text>' }),
    );
  }
}

/** Checks every header block's `mustUnderstand` attribute against the version's legal values. */
function checkMustUnderstand(header: Element, version: SoapEnvelopeVersion, problems: ValidationProblem[]): void {
  const legal = MUST_UNDERSTAND_VALUES[version];
  for (const block of elementChildren(header)) {
    const value = block.getAttributeNS(ENVELOPE_NS[version], 'mustUnderstand');
    if (value === null || value === '' || legal.includes(value)) {
      continue;
    }
    problems.push(
      at(block, {
        severity: 'error',
        code: 'invalid-must-understand',
        message: `mustUnderstand="${value}" is not legal in SOAP ${version} (expected ${legal.join(' or ')})`,
      }),
    );
  }
}

/** The value of one `Content-Type` parameter (e.g. `action`), unquoted, or `undefined`. */
function contentTypeParameter(contentType: string, name: string): string | undefined {
  const match = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(contentType);
  if (match === null) {
    return undefined;
  }
  return match[2] ?? match[1];
}

/** Strips the quotes SOAP 1.1 wraps a `SOAPAction` in, so the two spellings compare equal. */
function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** Whether `mediaType` is the media type SOAP `version` sends over the wire, MTOM included:
 * an MTOM-wrapped message's own `Content-Type` is `multipart/related`, with the actual SOAP
 * media type carried in its `type` parameter instead. */
function matchesMediaType(contentType: string, mediaType: string, version: SoapEnvelopeVersion): boolean {
  if (mediaType === MEDIA_TYPE[version]) {
    return true;
  }
  if (mediaType !== 'multipart/related') {
    return false;
  }
  const type = contentTypeParameter(contentType, 'type');
  return type !== undefined && unquote(type).toLowerCase() === MEDIA_TYPE[version];
}

/**
 * Compares the transport metadata against the version in the envelope. Media-type and
 * `action`-parameter mismatches are independent findings — a message can carry both — so
 * neither check short-circuits the other.
 */
function checkTransport(options: SoapStructureOptions, problems: ValidationProblem[]): void {
  const { contentType, expectedVersion, soapAction } = options;
  if (contentType === undefined) {
    return;
  }
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (mediaType.length > 0 && !matchesMediaType(contentType, mediaType, expectedVersion)) {
    problems.push({
      severity: 'warning',
      code: 'content-type-mismatch',
      message: `SOAP ${expectedVersion} expects Content-Type ${MEDIA_TYPE[expectedVersion]}, not ${mediaType}`,
      source: 'structure',
    });
  }
  if (expectedVersion !== '1.2' || soapAction === undefined) {
    return;
  }
  const action = contentTypeParameter(contentType, 'action');
  if (action !== undefined && unquote(action) !== unquote(soapAction)) {
    problems.push({
      severity: 'warning',
      code: 'soap-action-mismatch',
      message: `Content-Type action="${unquote(action)}" does not match the operation's action "${unquote(soapAction)}"`,
      source: 'structure',
    });
  }
}

/**
 * Checks the SOAP-level structure of `xml` against the binding's expectations.
 *
 * Never throws: a parse failure is reported as a single `xml-not-well-formed`
 * problem carrying the parser's line/column.
 *
 * @param xml the whole envelope text, as typed in the editor
 * @param options the binding's SOAP version, plus the transport metadata to cross-check
 * @returns every finding, in document order (transport findings last)
 */
export function checkSoapStructure(xml: string, options: SoapStructureOptions): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  let root: Element | null;
  try {
    root = parseXml(xml).documentElement;
  } catch (cause) {
    const details = cause instanceof WirebenchError ? cause.details : undefined;
    const line = typeof details?.['line'] === 'number' ? details['line'] : undefined;
    const column = typeof details?.['column'] === 'number' ? details['column'] : undefined;
    return [
      {
        severity: 'error',
        code: 'xml-not-well-formed',
        message: cause instanceof Error ? cause.message : 'The message is not well-formed XML',
        source: 'structure',
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {}),
      },
    ];
  }

  if (root === null) {
    return [
      {
        severity: 'error',
        code: 'xml-not-well-formed',
        message: 'The message is empty or has no root element',
        source: 'structure',
      },
    ];
  }

  const version: SoapEnvelopeVersion | undefined =
    root.namespaceURI === NS.SOAP11_ENV ? '1.1' : root.namespaceURI === NS.SOAP12_ENV ? '1.2' : undefined;
  if (root.localName !== 'Envelope' || version === undefined) {
    problems.push(
      at(root, {
        severity: 'error',
        code: 'not-an-envelope',
        message: `Expected a SOAP ${options.expectedVersion} <Envelope>, found <${root.tagName}>`,
        path: `/${root.tagName}`,
      }),
    );
    return problems;
  }

  if (version !== options.expectedVersion) {
    problems.push(
      at(root, {
        severity: 'error',
        code: 'soap-version-mismatch',
        message: `The binding is SOAP ${options.expectedVersion} but this envelope is SOAP ${version}`,
        path: `/${root.tagName}`,
      }),
    );
  }

  const envelopeNs = ENVELOPE_NS[version];
  const children = elementChildren(root);
  const headers = children.filter((child) => child.namespaceURI === envelopeNs && child.localName === 'Header');
  const bodies = children.filter((child) => child.namespaceURI === envelopeNs && child.localName === 'Body');

  for (const child of children) {
    if (child.namespaceURI === envelopeNs && (child.localName === 'Header' || child.localName === 'Body')) {
      continue;
    }
    problems.push(
      at(child, {
        severity: 'error',
        code: 'unexpected-envelope-child',
        message: `<${child.tagName}> is not allowed as a direct child of <Envelope>`,
      }),
    );
  }

  if (headers.length > 1) {
    problems.push(
      at(headers[1], {
        severity: 'error',
        code: 'multiple-header',
        message: 'An envelope may carry only one <Header>',
      }),
    );
  } else if (
    headers.length === 1 &&
    bodies.length > 0 &&
    children.indexOf(headers[0] as Element) > children.indexOf(bodies[0] as Element)
  ) {
    problems.push(
      at(headers[0], { severity: 'error', code: 'header-after-body', message: '<Header> must precede <Body>' }),
    );
  }

  if (bodies.length === 0) {
    problems.push(at(root, { severity: 'error', code: 'missing-body', message: 'The envelope has no <Body>' }));
  } else if (bodies.length > 1) {
    problems.push(
      at(bodies[1], { severity: 'error', code: 'multiple-body', message: 'An envelope may carry only one <Body>' }),
    );
  }

  const header = headers[0];
  if (header !== undefined) {
    checkMustUnderstand(header, version, problems);
  }

  const body = bodies[0];
  const fault = body === undefined ? undefined : elementChildren(body).find((child) => child.localName === 'Fault');
  if (fault !== undefined && fault.namespaceURI === envelopeNs) {
    checkFault(fault, version, problems);
  }

  checkTransport(options, problems);
  return problems;
}
