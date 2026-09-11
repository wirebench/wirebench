/**
 * Reads what a WSDL says about WS-Addressing, so an imported interface can turn addressing on
 * by itself instead of making the user discover the requirement from a runtime fault.
 *
 * Three shapes are recognised, all of which real services use:
 * - `wsaw:UsingAddressing` (or the 2004 `wsap:UsingAddressing`) on the binding or the port;
 * - a `wsp:Policy` — attached inline or through a `wsp:PolicyReference` to a `#id` — that
 *   contains `wsam:Addressing` or one of the `UsingAddressing` assertions;
 * - `wsam:Action` (or `wsaw:Action`) on a `portType` operation's `wsdl:input`, which also
 *   supplies that operation's default `wsa:Action`.
 */

import type { Document, Element } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import type { Binding, BindingOperation, Operation, PortType, WsdlDefinition } from '../wsdl/model.js';
import { findPortType } from '../wsdl/model.js';
import { qnameEquals } from '../wsdl/qname.js';
import type { WsaVersion } from './model.js';

/** The `wsp:Policy`/`wsp:PolicyReference` namespaces, newest first. */
const POLICY_NAMESPACES = [NS.WSP, NS.WSP_2004] as const;

/** What a WSDL says about WS-Addressing for one binding operation. */
export interface WsaDetection {
  /** True when the definition asks for WS-Addressing at all. */
  readonly usingAddressing: boolean;
  /** The addressing version the definition's markers imply. */
  readonly version: WsaVersion;
  /** The operation's default `wsa:Action`, when the WSDL declares one. */
  readonly action?: string;
}

/** Every descendant element of `root` (excluding `root` itself), in document order. */
function descendants(root: Element): Element[] {
  const found: Element[] = [];
  const walk = (element: Element): void => {
    for (let node = element.firstChild; node !== null; node = node.nextSibling) {
      if (node.nodeType === 1) {
        found.push(node as Element);
        walk(node as Element);
      }
    }
  };
  walk(root);
  return found;
}

/** True when `element` is one of the addressing assertions; `version` says which flavour. */
function addressingAssertion(element: Element): WsaVersion | undefined {
  const { namespaceURI: ns, localName } = element;
  if (ns === NS.WSAP_2004 && localName === 'UsingAddressing') {
    return '2004/08';
  }
  if (ns === NS.WSAW && localName === 'UsingAddressing') {
    return '2005/08';
  }
  if (ns === NS.WSAM && (localName === 'Addressing' || localName === 'AnonymousResponses')) {
    return '2005/08';
  }
  return undefined;
}

/** The `wsp:Policy` element with `wsu:Id`/`xml:id`/`Id` equal to `id`, anywhere in `doc`. */
function policyById(doc: Document, id: string): Element | undefined {
  const root = doc.documentElement;
  if (root === null) {
    return undefined;
  }
  for (const element of descendants(root)) {
    if (!POLICY_NAMESPACES.some((ns) => ns === element.namespaceURI) || element.localName !== 'Policy') {
      continue;
    }
    const candidate =
      element.getAttributeNS(NS.WSU, 'Id') ?? element.getAttributeNS(NS.XML, 'id') ?? element.getAttribute('Id');
    if (candidate === id) {
      return element;
    }
  }
  return undefined;
}

/**
 * The addressing assertions reachable from `owner`: its own extension children, plus every
 * policy it attaches inline or references by `#id`.
 */
function assertionsUnder(owner: Element): WsaVersion[] {
  const versions: WsaVersion[] = [];
  const consider = (element: Element): void => {
    const version = addressingAssertion(element);
    if (version !== undefined) {
      versions.push(version);
    }
  };
  for (let node = owner.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType !== 1) {
      continue;
    }
    const element = node as Element;
    consider(element);
    const isPolicyNs = POLICY_NAMESPACES.some((ns) => ns === element.namespaceURI);
    if (isPolicyNs && element.localName === 'Policy') {
      descendants(element).forEach(consider);
      continue;
    }
    if (isPolicyNs && element.localName === 'PolicyReference') {
      const uri = element.getAttribute('URI');
      const doc = owner.ownerDocument;
      if (uri !== null && uri.startsWith('#') && doc !== null) {
        const policy = policyById(doc, uri.slice(1));
        if (policy !== undefined) {
          consider(policy);
          descendants(policy).forEach(consider);
        }
      }
    }
  }
  return versions;
}

/** The `wsam:Action`/`wsaw:Action` attribute of a `portType` operation's `wsdl:input`. */
function declaredAction(operation: Operation | undefined): string | undefined {
  const input = operation?.input?.sourceElement;
  if (input === undefined) {
    return undefined;
  }
  for (const ns of [NS.WSAM, NS.WSAW] as const) {
    const value = input.getAttributeNS(ns, 'Action');
    if (value !== null && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** Joins `parts` with single `/` separators, tolerating a target namespace with a trailing one. */
function joinUri(...parts: readonly string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .join('/');
}

/**
 * The default `wsa:Action` for one operation, following the WS-Addressing 1.0 WSDL binding's
 * precedence: an explicit `wsam:Action`, then a non-empty `soapAction`, then the default
 * pattern `<targetNamespace>/<portType>/<operation>Request`.
 *
 * @param definition the definition the operation belongs to
 * @param portType the operation's `wsdl:portType`
 * @param operation the abstract `wsdl:operation`
 * @param options `soapAction` from the binding operation, when it has one
 */
export function defaultAction(
  definition: WsdlDefinition,
  portType: PortType,
  operation: Operation,
  options?: { readonly soapAction?: string },
): string {
  const declared = declaredAction(operation);
  if (declared !== undefined) {
    return declared;
  }
  const soapAction = options?.soapAction;
  if (soapAction !== undefined && soapAction.length > 0) {
    return soapAction;
  }
  const namespace = portType.name.namespaceUri.length > 0 ? portType.name.namespaceUri : definition.targetNamespace;
  return joinUri(namespace, portType.name.localName, `${operation.name}Request`);
}

/** The ports, across every service, that bind to `binding`. */
function portElementsFor(definition: WsdlDefinition, binding: Binding): Element[] {
  const elements: Element[] = [];
  for (const service of definition.services) {
    for (const port of service.ports) {
      if (qnameEquals(port.binding, binding.name) && port.sourceElement !== undefined) {
        elements.push(port.sourceElement);
      }
    }
  }
  return elements;
}

/**
 * What `definition` says about WS-Addressing for one binding operation.
 *
 * `version` is `'2004/08'` only when *every* marker found is a 2004 one; a definition that
 * mixes the two (or declares none at all) is treated as 2005/08, the version a modern stack
 * speaks.
 *
 * @param definition the imported definition
 * @param binding the binding the operation belongs to
 * @param operation the binding operation, for its `soapAction` and abstract counterpart
 */
export function detectWsaDefaults(
  definition: WsdlDefinition,
  binding: Binding,
  operation: BindingOperation,
): WsaDetection {
  const owners = [
    ...(binding.sourceElement !== undefined ? [binding.sourceElement] : []),
    ...portElementsFor(definition, binding),
  ];
  const versions = owners.flatMap(assertionsUnder);
  const portType = findPortType(definition, binding.type);
  const abstract = portType?.operations.find((candidate) => candidate.name === operation.name);
  const action = declaredAction(abstract);
  const usingAddressing = versions.length > 0 || action !== undefined;
  const version: WsaVersion = versions.length > 0 && versions.every((v) => v === '2004/08') ? '2004/08' : '2005/08';
  return {
    usingAddressing,
    version,
    ...(action !== undefined ? { action } : {}),
  };
}

/** What an import records about WS-Addressing for a whole interface. */
export interface WsaSummary {
  /** True when any binding of the definition asks for WS-Addressing. */
  readonly enabled: boolean;
  readonly version: WsaVersion;
  /** Operation name to its default `wsa:Action`, for every operation in the definition. */
  readonly defaultActionByOperation: Readonly<Record<string, string>>;
}

/**
 * Folds {@link detectWsaDefaults} and {@link defaultAction} over every binding operation, for
 * the interface summary an import produces.
 *
 * @param definition the imported definition
 */
export function summarizeWsa(definition: WsdlDefinition): WsaSummary {
  let enabled = false;
  const versions: WsaVersion[] = [];
  const defaultActionByOperation: Record<string, string> = {};
  for (const binding of definition.bindings) {
    const portType = findPortType(definition, binding.type);
    for (const operation of binding.operations) {
      const detected = detectWsaDefaults(definition, binding, operation);
      if (detected.usingAddressing) {
        enabled = true;
        versions.push(detected.version);
      }
      const abstract = portType?.operations.find((candidate) => candidate.name === operation.name);
      if (portType !== undefined && abstract !== undefined) {
        defaultActionByOperation[operation.name] = defaultAction(definition, portType, abstract, {
          ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
        });
      }
    }
  }
  return {
    enabled,
    version: versions.length > 0 && versions.every((v) => v === '2004/08') ? '2004/08' : '2005/08',
    defaultActionByOperation,
  };
}
