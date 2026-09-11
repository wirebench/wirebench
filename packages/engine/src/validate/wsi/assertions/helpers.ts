/**
 * Shared DOM navigation for the WS-I assertions.
 *
 * The assertions work on the *raw* documents rather than the merged {@link WsdlDefinition}: the
 * profile constrains constructs the model normalizes away (a missing `use` attribute, a `parts`
 * list, the order of `wsdl:input`/`wsdl:output`), and findings need the document and position the
 * offending element actually came from.
 */

import type { Element, Node } from '@xmldom/xmldom';
import { NS } from '../../../xml/namespaces.js';
import { getPosition } from '../../../xml/parse.js';
import { childElements, firstChildElement, optionalAttribute } from '../../../wsdl/dom-utils.js';
import { parseQName, qnameToString } from '../../../wsdl/qname.js';
import type { QName } from '../../../wsdl/qname.js';
import type { BundledDocument } from '../../../wsdl/resolver.js';
import type { WsiFinding, WsiWsdlContext } from '../types.js';

/** The two WSDL SOAP binding namespaces, in the order they are probed. */
export const SOAP_BINDING_NAMESPACES = [NS.WSDL_SOAP11, NS.WSDL_SOAP12] as const;

/** One `wsdl:definitions` document of the bundle. */
export interface WsdlDocumentView {
  readonly location: string;
  readonly definitions: Element;
}

/** Every `wsdl:definitions` document in the bundle, in discovery order. */
export function wsdlDocuments(context: WsiWsdlContext): readonly WsdlDocumentView[] {
  const views: WsdlDocumentView[] = [];
  for (const doc of context.bundle.documents) {
    const root = context.documents.get(doc.location)?.documentElement ?? null;
    if (root !== null && root.namespaceURI === NS.WSDL && root.localName === 'definitions') {
      views.push({ location: doc.location, definitions: root });
    }
  }
  return views;
}

/** One `xs:schema` element of the bundle, with the document it was found in. */
export interface SchemaView {
  readonly location: string;
  readonly schema: Element;
}

/** Every `xs:schema` element in the bundle: the inline ones first, then standalone XSD roots. */
export function schemaElements(context: WsiWsdlContext): readonly SchemaView[] {
  const views: SchemaView[] = [];
  for (const doc of context.bundle.documents) {
    const root = context.documents.get(doc.location)?.documentElement ?? null;
    if (root === null) {
      continue;
    }
    if (root.namespaceURI === NS.WSDL && root.localName === 'definitions') {
      const typesEl = firstChildElement(root, NS.WSDL, 'types');
      if (typesEl !== undefined) {
        for (const schema of childElements(typesEl, NS.XSD, 'schema')) {
          views.push({ location: doc.location, schema });
        }
      }
    } else if (root.namespaceURI === NS.XSD && root.localName === 'schema') {
      views.push({ location: doc.location, schema: root });
    }
  }
  return views;
}

/** Every descendant element of `root` (excluding `root` itself), depth first. */
export function descendants(root: Element): readonly Element[] {
  const out: Element[] = [];
  const visit = (parent: Element): void => {
    let child: Node | null = parent.firstChild;
    while (child !== null) {
      if (child.nodeType === 1) {
        const element = child as Element;
        out.push(element);
        visit(element);
      }
      child = child.nextSibling;
    }
  };
  visit(root);
  return out;
}

/** The SOAP binding namespace a `wsdl:binding` uses, or `undefined` when it is not a SOAP binding. */
export function soapNamespaceOf(binding: Element): string | undefined {
  return SOAP_BINDING_NAMESPACES.find((ns) => firstChildElement(binding, ns, 'binding') !== undefined);
}

/** The SOAP bindings of every document, paired with the SOAP namespace they use. */
export interface SoapBindingView {
  readonly location: string;
  readonly binding: Element;
  readonly soapNs: string;
  /** The binding's `soapbind:binding` element. */
  readonly soapBinding: Element;
}

/** Every `wsdl:binding` that is a SOAP binding, across the whole bundle. */
export function soapBindings(context: WsiWsdlContext): readonly SoapBindingView[] {
  const views: SoapBindingView[] = [];
  for (const doc of wsdlDocuments(context)) {
    for (const binding of childElements(doc.definitions, NS.WSDL, 'binding')) {
      const soapNs = soapNamespaceOf(binding);
      const soapBinding = soapNs === undefined ? undefined : firstChildElement(binding, soapNs, 'binding');
      if (soapNs !== undefined && soapBinding !== undefined) {
        views.push({ location: doc.location, binding, soapNs, soapBinding });
      }
    }
  }
  return views;
}

/** The effective style of one binding operation: its own `soapbind:operation/@style`, else the binding's. */
export function operationStyle(view: SoapBindingView, operation: Element): 'document' | 'rpc' {
  const soapOperation = firstChildElement(operation, view.soapNs, 'operation');
  const own = soapOperation === undefined ? undefined : optionalAttribute(soapOperation, 'style');
  if (own === 'rpc' || own === 'document') {
    return own;
  }
  return optionalAttribute(view.soapBinding, 'style') === 'rpc' ? 'rpc' : 'document';
}

/** The `wsdl:input`/`wsdl:output` children of a binding operation, in document order. */
export function bindingMessages(operation: Element): readonly Element[] {
  return [...childElements(operation, NS.WSDL, 'input'), ...childElements(operation, NS.WSDL, 'output')];
}

/** The `soapbind:body` of a binding `wsdl:input`/`wsdl:output`, if it declares one. */
export function soapBodyOf(message: Element, soapNs: string): Element | undefined {
  return firstChildElement(message, soapNs, 'body');
}

/** Resolves a QName-valued attribute against the in-scope prefixes of `element`. */
export function attributeQName(element: Element, attribute: string, defaultNamespace: string): QName | undefined {
  const raw = optionalAttribute(element, attribute);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return parseQName(raw, element, defaultNamespace);
  } catch {
    // An unbound prefix is a well-formedness problem the WSDL parser reports; for the profile
    // assertions the reference is simply unresolvable.
    return undefined;
  }
}

/** The `targetNamespace` of the `wsdl:definitions` an element belongs to (empty string when absent). */
export function targetNamespaceOf(definitions: Element): string {
  return optionalAttribute(definitions, 'targetNamespace') ?? '';
}

/** A bundle-wide index of the WSDL components assertions cross-reference, keyed by Clark name. */
export interface WsdlIndex {
  readonly messages: ReadonlyMap<string, WsdlComponent>;
  readonly portTypes: ReadonlyMap<string, WsdlComponent>;
}

/** One indexed WSDL component: its element plus the document it came from. */
export interface WsdlComponent {
  readonly location: string;
  readonly element: Element;
}

const indexCache = new WeakMap<WsiWsdlContext, WsdlIndex>();

/** Indexes every `wsdl:message` and `wsdl:portType` of the bundle by expanded name (cached per context). */
export function wsdlIndex(context: WsiWsdlContext): WsdlIndex {
  const cached = indexCache.get(context);
  if (cached !== undefined) {
    return cached;
  }
  const messages = new Map<string, WsdlComponent>();
  const portTypes = new Map<string, WsdlComponent>();
  for (const doc of wsdlDocuments(context)) {
    const tns = targetNamespaceOf(doc.definitions);
    for (const [localName, target] of [
      ['message', messages],
      ['portType', portTypes],
    ] as const) {
      for (const element of childElements(doc.definitions, NS.WSDL, localName)) {
        const name = optionalAttribute(element, 'name');
        if (name !== undefined) {
          const key = qnameToString({ namespaceUri: tns, localName: name });
          if (!target.has(key)) {
            target.set(key, { location: doc.location, element });
          }
        }
      }
    }
  }
  const index: WsdlIndex = { messages, portTypes };
  indexCache.set(context, index);
  return index;
}

/** Looks a `wsdl:message` up by the QName an attribute of `element` refers to. */
export function referencedMessage(
  context: WsiWsdlContext,
  element: Element,
  attribute: string,
  defaultNamespace: string,
): WsdlComponent | undefined {
  const qname = attributeQName(element, attribute, defaultNamespace);
  return qname === undefined ? undefined : wsdlIndex(context).messages.get(qnameToString(qname));
}

/** The `wsdl:part` children of a `wsdl:message`. */
export function messageParts(message: Element): readonly Element[] {
  return childElements(message, NS.WSDL, 'part');
}

/** Finds a `wsdl:part` of `message` by name. */
export function findPart(message: Element, name: string): Element | undefined {
  return messageParts(message).find((part) => optionalAttribute(part, 'name') === name);
}

/** A readable element path, using `@name` where an element has one and a position index otherwise. */
export function xpathOf(element: Element): string {
  const steps: string[] = [];
  let current: Element | null = element;
  while (current !== null && current.nodeType === 1) {
    const name = optionalAttribute(current, 'name');
    steps.unshift(`${current.localName ?? current.nodeName}${name !== undefined ? `[@name='${name}']` : ''}`);
    const parent: Node | null = current.parentNode;
    current = parent !== null && parent.nodeType === 1 ? (parent as Element) : null;
  }
  return `/${steps.join('/')}`;
}

/** Builds a finding pointing at `element` in the document at `location`. */
export function findingAt(location: string, element: Element, message: string): WsiFinding {
  const position = getPosition(element);
  return {
    message,
    location: { document: location, ...(position !== undefined ? position : {}), xpath: xpathOf(element) },
  };
}

/** True when `value` is an absolute URI (a scheme followed by a scheme-specific part). */
export function isAbsoluteUri(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/** Resolves a relative reference against a base location, returning `undefined` when it is not resolvable. */
export function resolveAgainst(reference: string, base: string): string | undefined {
  try {
    return new URL(reference, base).toString();
  } catch {
    return undefined;
  }
}

/** Looks a bundled document up by the location one of its importers referenced. */
export function bundledDocumentFor(context: WsiWsdlContext, resolvedLocation: string): BundledDocument | undefined {
  return context.bundle.documents.find(
    (doc) => doc.location === resolvedLocation || doc.requestedLocation === resolvedLocation,
  );
}

/** One side of one binding operation, joined to the abstract message it binds. */
export interface BoundMessageView {
  readonly location: string;
  readonly bindingView: SoapBindingView;
  /** The `wsdl:operation` inside the `wsdl:binding`. */
  readonly operation: Element;
  readonly direction: 'input' | 'output';
  /** The `wsdl:input`/`wsdl:output` inside the binding operation. */
  readonly messageElement: Element;
  readonly soapBody?: Element;
  readonly style: 'document' | 'rpc';
  /** The `wsdl:message` the port type's operation refers to, when it resolves. */
  readonly abstractMessage?: WsdlComponent;
  /** Every `wsdl:part` of that message. */
  readonly parts: readonly Element[];
  /** The names listed in `soapbind:body/@parts`, or `undefined` when the attribute is absent. */
  readonly declaredParts?: readonly string[];
  /** The parts actually bound to the SOAP body: the declared subset, or all of them. */
  readonly boundParts: readonly Element[];
}

/** The `wsdl:portType` a binding refers to, when it resolves. */
export function portTypeOf(
  context: WsiWsdlContext,
  view: SoapBindingView,
  definitions: Element,
): WsdlComponent | undefined {
  const qname = attributeQName(view.binding, 'type', targetNamespaceOf(definitions));
  return qname === undefined ? undefined : wsdlIndex(context).portTypes.get(qnameToString(qname));
}

/** Joins every binding operation's input/output to the abstract message it binds. */
export function boundMessages(context: WsiWsdlContext): readonly BoundMessageView[] {
  const views: BoundMessageView[] = [];
  for (const doc of wsdlDocuments(context)) {
    const tns = targetNamespaceOf(doc.definitions);
    for (const binding of childElements(doc.definitions, NS.WSDL, 'binding')) {
      const soapNs = soapNamespaceOf(binding);
      const soapBinding = soapNs === undefined ? undefined : firstChildElement(binding, soapNs, 'binding');
      if (soapNs === undefined || soapBinding === undefined) {
        continue;
      }
      const bindingView: SoapBindingView = { location: doc.location, binding, soapNs, soapBinding };
      const portType = portTypeOf(context, bindingView, doc.definitions);
      for (const operation of childElements(binding, NS.WSDL, 'operation')) {
        const operationName = optionalAttribute(operation, 'name');
        const abstractOperation =
          portType === undefined || operationName === undefined
            ? undefined
            : childElements(portType.element, NS.WSDL, 'operation').find(
                (candidate) => optionalAttribute(candidate, 'name') === operationName,
              );
        for (const direction of ['input', 'output'] as const) {
          const messageElement = firstChildElement(operation, NS.WSDL, direction);
          if (messageElement === undefined) {
            continue;
          }
          const abstractSide =
            abstractOperation === undefined ? undefined : firstChildElement(abstractOperation, NS.WSDL, direction);
          const abstractMessage =
            abstractSide === undefined ? undefined : referencedMessage(context, abstractSide, 'message', tns);
          const parts = abstractMessage === undefined ? [] : messageParts(abstractMessage.element);
          const soapBody = soapBodyOf(messageElement, soapNs);
          const rawParts = soapBody === undefined ? undefined : optionalAttribute(soapBody, 'parts');
          const declaredParts = rawParts?.split(/\s+/).filter((name) => name.length > 0);
          const boundParts =
            declaredParts === undefined
              ? parts
              : parts.filter((part) => declaredParts.includes(optionalAttribute(part, 'name') ?? ''));
          views.push({
            location: doc.location,
            bindingView,
            operation,
            direction,
            messageElement,
            ...(soapBody !== undefined ? { soapBody } : {}),
            style: operationStyle(bindingView, operation),
            ...(abstractMessage !== undefined ? { abstractMessage } : {}),
            parts,
            ...(declaredParts !== undefined ? { declaredParts } : {}),
            boundParts,
          });
        }
      }
    }
  }
  return views;
}

/** One `soapbind:` extension element of a binding, with the context needed to judge it. */
export interface SoapExtensionView {
  readonly location: string;
  readonly bindingView: SoapBindingView;
  /** The `wsdl:operation` of the binding the extension belongs to. */
  readonly operation: Element;
  /** The `soapbind:body`/`header`/`headerfault`/`fault` element itself. */
  readonly element: Element;
  readonly kind: 'body' | 'header' | 'headerfault' | 'fault';
  /** The enclosing `wsdl:fault`, for a `soapbind:fault`. */
  readonly wsdlFault?: Element;
  readonly style: 'document' | 'rpc';
}

/** Every `soapbind:body`/`header`/`headerfault`/`fault` element of every SOAP binding. */
export function soapExtensions(context: WsiWsdlContext): readonly SoapExtensionView[] {
  const views: SoapExtensionView[] = [];
  for (const bindingView of soapBindings(context)) {
    const { location, soapNs } = bindingView;
    for (const operation of childElements(bindingView.binding, NS.WSDL, 'operation')) {
      const style = operationStyle(bindingView, operation);
      const base = { location, bindingView, operation, style } as const;
      for (const message of bindingMessages(operation)) {
        const body = soapBodyOf(message, soapNs);
        if (body !== undefined) {
          views.push({ ...base, element: body, kind: 'body' });
        }
        for (const header of childElements(message, soapNs, 'header')) {
          views.push({ ...base, element: header, kind: 'header' });
          for (const headerfault of childElements(header, soapNs, 'headerfault')) {
            views.push({ ...base, element: headerfault, kind: 'headerfault' });
          }
        }
      }
      for (const wsdlFault of childElements(operation, NS.WSDL, 'fault')) {
        for (const fault of childElements(wsdlFault, soapNs, 'fault')) {
          views.push({ ...base, element: fault, kind: 'fault', wsdlFault });
        }
      }
    }
  }
  return views;
}

/** One `soapbind:address` of a `wsdl:port`. */
export interface SoapAddressView {
  readonly location: string;
  readonly port: Element;
  readonly address: Element;
}

/** Every `soapbind:address` element in the bundle. */
export function soapAddresses(context: WsiWsdlContext): readonly SoapAddressView[] {
  const views: SoapAddressView[] = [];
  for (const doc of wsdlDocuments(context)) {
    for (const service of childElements(doc.definitions, NS.WSDL, 'service')) {
      for (const port of childElements(service, NS.WSDL, 'port')) {
        for (const ns of SOAP_BINDING_NAMESPACES) {
          const address = firstChildElement(port, ns, 'address');
          if (address !== undefined) {
            views.push({ location: doc.location, port, address });
          }
        }
      }
    }
  }
  return views;
}
