import type { Document, Element } from '@xmldom/xmldom';
import { WsdlParseError } from '../errors.js';
import { NS } from '../xml/namespaces.js';
import { getPosition, parseXml } from '../xml/parse.js';
import {
  childElements,
  firstChildElement,
  optionalAttribute,
  readDocumentation,
  requireAttribute,
} from './dom-utils.js';
import { parseWsdlBundle } from './merge.js';
import type { Fault, Message, MessageRef, Operation, Part, PortType, WsdlDefinition, WsdlImport } from './model.js';
import { parseBinding, parseService } from './parse-binding.js';
import type { QName } from './qname.js';
import { parseQName } from './qname.js';
import { resolveDefinition } from './resolver.js';
import type { FetchDocument } from './resolver.js';

/**
 * Source of a WSDL document. `text` is required when `resolveImports` is
 * `false` (there is nothing to fetch it with); it is optional when
 * `resolveImports` is `true`, in which case an absent `text` is fetched via
 * `fetchDocument`.
 */
export interface WsdlDocumentSource {
  readonly location: string;
  readonly text?: string;
}

/** Options for {@link parseWsdl}. */
export interface ParseWsdlOptions {
  /** Fetches a WSDL/XSD document by location. Unused while `resolveImports` is `false`. */
  readonly fetchDocument: FetchDocument;
  /** Whether to follow `wsdl:import`/`xsd:import`/`xsd:include`/`xsd:redefine`. */
  readonly resolveImports: boolean;
  readonly signal?: AbortSignal;
}

function parsePart(partEl: Element, location: string, defaultNamespace: string): Part {
  const elementAttr = optionalAttribute(partEl, 'element');
  const typeAttr = optionalAttribute(partEl, 'type');
  return {
    name: requireAttribute(partEl, 'name', location),
    ...(elementAttr !== undefined ? { element: parseQName(elementAttr, partEl, defaultNamespace) } : {}),
    ...(typeAttr !== undefined ? { type: parseQName(typeAttr, partEl, defaultNamespace) } : {}),
  };
}

function parseMessage(messageEl: Element, location: string, defaultNamespace: string): Message {
  const documentation = readDocumentation(messageEl, NS.WSDL);
  const parts = childElements(messageEl, NS.WSDL, 'part').map((p) => parsePart(p, location, defaultNamespace));
  const name: QName = { namespaceUri: defaultNamespace, localName: requireAttribute(messageEl, 'name', location) };
  return {
    name,
    ...(documentation !== undefined ? { documentation } : {}),
    parts,
  };
}

function parseMessageRef(el: Element, location: string, defaultNamespace: string): MessageRef {
  const name = optionalAttribute(el, 'name');
  return {
    ...(name !== undefined ? { name } : {}),
    message: parseQName(requireAttribute(el, 'message', location), el, defaultNamespace),
  };
}

function parseOperationFault(el: Element, location: string, defaultNamespace: string): Fault {
  const documentation = readDocumentation(el, NS.WSDL);
  return {
    name: requireAttribute(el, 'name', location),
    message: parseQName(requireAttribute(el, 'message', location), el, defaultNamespace),
    ...(documentation !== undefined ? { documentation } : {}),
  };
}

function parseOperation(opEl: Element, location: string, defaultNamespace: string): Operation {
  const documentation = readDocumentation(opEl, NS.WSDL);
  const inputEl = firstChildElement(opEl, NS.WSDL, 'input');
  const outputEl = firstChildElement(opEl, NS.WSDL, 'output');
  const faults = childElements(opEl, NS.WSDL, 'fault').map((f) => parseOperationFault(f, location, defaultNamespace));
  const parameterOrderAttr = optionalAttribute(opEl, 'parameterOrder');
  return {
    name: requireAttribute(opEl, 'name', location),
    ...(documentation !== undefined ? { documentation } : {}),
    ...(inputEl !== undefined ? { input: parseMessageRef(inputEl, location, defaultNamespace) } : {}),
    ...(outputEl !== undefined ? { output: parseMessageRef(outputEl, location, defaultNamespace) } : {}),
    faults,
    ...(parameterOrderAttr !== undefined
      ? { parameterOrder: parameterOrderAttr.split(/\s+/).filter((p) => p.length > 0) }
      : {}),
  };
}

function parsePortType(portTypeEl: Element, location: string, defaultNamespace: string): PortType {
  const documentation = readDocumentation(portTypeEl, NS.WSDL);
  const operations = childElements(portTypeEl, NS.WSDL, 'operation').map((op) =>
    parseOperation(op, location, defaultNamespace),
  );
  const name: QName = { namespaceUri: defaultNamespace, localName: requireAttribute(portTypeEl, 'name', location) };
  return {
    name,
    ...(documentation !== undefined ? { documentation } : {}),
    operations,
  };
}

function parseImport(importEl: Element, location: string): WsdlImport {
  const namespace = optionalAttribute(importEl, 'namespace');
  return {
    ...(namespace !== undefined ? { namespace } : {}),
    location: requireAttribute(importEl, 'location', location),
  };
}

/**
 * Collects the `xmlns:*` declarations on the root `wsdl:definitions` element.
 * The default (unprefixed) `xmlns` declaration is deliberately excluded: the
 * values these are used to resolve (`wsdl:arrayType`) are always prefixed.
 */
function readNamespaceDeclarations(root: Element): Readonly<Record<string, string>> {
  const declarations: Record<string, string> = {};
  const attributes = root.attributes;
  for (let i = 0; i < attributes.length; i += 1) {
    const attribute = attributes.item(i);
    if (attribute !== null && attribute.name.startsWith('xmlns:')) {
      declarations[attribute.name.slice('xmlns:'.length)] = attribute.value;
    }
  }
  return declarations;
}

/**
 * Parses a single, already-loaded WSDL 1.1 `Document` into a {@link WsdlDefinition}.
 *
 * Pure and synchronous: it does not resolve `wsdl:import`s or fetch anything,
 * and does not validate cross-references (e.g. a binding's `type` pointing at
 * an unknown `portType`) — only structural requirements of the WSDL document
 * itself (required attributes) are enforced.
 *
 * @param doc the parsed WSDL document
 * @param location a human-readable origin for the document, echoed into the resulting model and errors
 * @throws {WsdlParseError} with code `not-a-wsdl` if the root element is not `{NS.WSDL}definitions`
 * @throws {WsdlParseError} with code `wsdl-invalid` for structural errors (e.g. a missing required attribute)
 */
export function parseWsdlDocument(doc: Document, location: string): WsdlDefinition {
  const root = doc.documentElement;
  if (root === null || root.namespaceURI !== NS.WSDL || root.localName !== 'definitions') {
    const pos = root !== null ? getPosition(root) : undefined;
    throw new WsdlParseError('not-a-wsdl', `Document at "${location}" is not a WSDL 1.1 <definitions> root`, {
      details: { location, rootTag: root?.tagName, ...pos },
    });
  }

  const targetNamespace = optionalAttribute(root, 'targetNamespace') ?? '';
  const namespaceDeclarations = readNamespaceDeclarations(root);
  const documentation = readDocumentation(root, NS.WSDL);

  const typesEl = firstChildElement(root, NS.WSDL, 'types');
  const schemaElements = typesEl !== undefined ? childElements(typesEl, NS.XSD, 'schema') : [];

  const imports = childElements(root, NS.WSDL, 'import').map((el) => parseImport(el, location));
  const messages = childElements(root, NS.WSDL, 'message').map((el) => parseMessage(el, location, targetNamespace));
  const portTypes = childElements(root, NS.WSDL, 'portType').map((el) => parsePortType(el, location, targetNamespace));
  const bindings = childElements(root, NS.WSDL, 'binding').map((el) => parseBinding(el, location, targetNamespace));
  const services = childElements(root, NS.WSDL, 'service').map((el) => parseService(el, location, targetNamespace));

  return {
    location,
    targetNamespace,
    ...(documentation !== undefined ? { documentation } : {}),
    messages,
    portTypes,
    bindings,
    services,
    schemaElements,
    imports,
    namespaceDeclarations,
    problems: [],
  };
}

/**
 * Parses a WSDL 1.1 document, given its root source.
 *
 * When `options.resolveImports` is `false`, only `root.text` is parsed as a
 * single document (`fetchDocument` is unused). When `true`, the full import
 * graph (`wsdl:import`/`xsd:import`/`xsd:include`/`xsd:redefine`) is resolved
 * via {@link resolveDefinition} and merged via {@link parseWsdlBundle}.
 *
 * @throws {WsdlParseError} propagated from {@link parseWsdlDocument} for `not-a-wsdl`/`wsdl-invalid`
 * @throws {WsdlParseError} with code `fetch-failed` if the root document cannot be fetched while resolving imports
 */
export async function parseWsdl(root: WsdlDocumentSource, options: ParseWsdlOptions): Promise<WsdlDefinition> {
  if (!options.resolveImports) {
    if (root.text === undefined) {
      throw new WsdlParseError('wsdl-invalid', 'root.text is required when resolveImports is false', {
        details: { location: root.location },
      });
    }
    return parseWsdlDocument(parseXml(root.text, { location: root.location }), root.location);
  }
  const bundle = await resolveDefinition(
    { location: root.location, ...(root.text !== undefined ? { text: root.text } : {}) },
    { fetchDocument: options.fetchDocument, ...(options.signal !== undefined ? { signal: options.signal } : {}) },
  );
  return parseWsdlBundle(bundle);
}
