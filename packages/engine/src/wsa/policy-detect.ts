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
import type { QName } from '../wsdl/qname.js';
import { qnameEquals, qnameToString } from '../wsdl/qname.js';
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
  /**
   * True when the only addressing markers found are `wsp:Optional="true"` and there is no
   * declared `wsa:Action` to force it on anyway — the WSDL merely *offers* addressing, so it
   * must not auto-enable (`usingAddressing` is `false` in this case).
   */
  readonly optional?: boolean;
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

/** One addressing assertion found in a WSDL/policy tree: which flavour, and whether it is `wsp:Optional="true"`. */
interface Assertion {
  readonly version: WsaVersion;
  readonly optional: boolean;
}

/** True when `value` is the WS-Policy "true" spelling (`true` or `1`) used by `wsp:Optional`. */
function isPolicyTrue(value: string | null): boolean {
  return value === 'true' || value === '1';
}

/** True when `element` carries `wsp:Optional="true"` (either policy-namespace flavour). */
function isOptionalAssertion(element: Element): boolean {
  return POLICY_NAMESPACES.some((ns) => isPolicyTrue(element.getAttributeNS(ns, 'Optional')));
}

/** True when `element` is one of the addressing assertions; describes which flavour and optionality. */
function addressingAssertion(element: Element): Assertion | undefined {
  const { namespaceURI: ns, localName } = element;
  const optional = isOptionalAssertion(element);
  if (ns === NS.WSAP_2004 && localName === 'UsingAddressing') {
    return { version: '2004/08', optional };
  }
  if (ns === NS.WSAW && localName === 'UsingAddressing') {
    return { version: '2005/08', optional };
  }
  if (ns === NS.WSAM && (localName === 'Addressing' || localName === 'AnonymousResponses')) {
    return { version: '2005/08', optional };
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
    const wsuId = element.getAttributeNS(NS.WSU, 'Id');
    const xmlId = element.getAttributeNS(NS.XML, 'id');
    const plainId = element.getAttribute('Id');
    const candidate =
      wsuId !== null && wsuId.length > 0
        ? wsuId
        : xmlId !== null && xmlId.length > 0
          ? xmlId
          : plainId !== null && plainId.length > 0
            ? plainId
            : undefined;
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
function assertionsUnder(owner: Element): Assertion[] {
  const versions: Assertion[] = [];
  const consider = (element: Element): void => {
    const assertion = addressingAssertion(element);
    if (assertion !== undefined) {
      versions.push(assertion);
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
  const assertions = owners.flatMap(assertionsUnder);
  const portType = findPortType(definition, binding.type);
  const abstract = portType?.operations.find((candidate) => candidate.name === operation.name);
  const action = declaredAction(abstract);
  const required = assertions.filter((assertion) => !assertion.optional);
  const usingAddressing = required.length > 0 || action !== undefined;
  const versionSource = required.length > 0 ? required : assertions;
  const version: WsaVersion =
    versionSource.length > 0 && versionSource.every((a) => a.version === '2004/08') ? '2004/08' : '2005/08';
  // Optional only when the WSDL merely offers addressing (no required assertion, no declared
  // action) but does say something — an `wsp:Optional="true"` assertion.
  const optional = !usingAddressing && assertions.some((assertion) => assertion.optional);
  return {
    usingAddressing,
    version,
    ...(action !== undefined ? { action } : {}),
    ...(optional ? { optional: true } : {}),
  };
}

/** What an import records about WS-Addressing for a whole interface. */
export interface WsaSummary {
  /** True when any binding of the definition asks for WS-Addressing. */
  readonly enabled: boolean;
  /**
   * True when no binding requires addressing but at least one only *offers* it
   * (`wsp:Optional="true"`) — the inspector shows "WSDL offers WS-Addressing (optional)"
   * rather than auto-enabling.
   */
  readonly optional: boolean;
  readonly version: WsaVersion;
  /**
   * Each binding operation's default `wsa:Action`, keyed by Clark-notation binding QName and
   * operation name (`{namespace}Binding|Operation`) so two bindings that happen to share an
   * operation name do not overwrite each other's default action.
   */
  readonly defaultActionByOperation: Readonly<Record<string, string>>;
}

/** The `defaultActionByOperation` key for one binding operation: `{ns}Binding|Operation`. */
export function wsaActionKey(bindingName: QName, operationName: string): string {
  return `${qnameToString(bindingName)}|${operationName}`;
}

/**
 * Folds {@link detectWsaDefaults} and {@link defaultAction} over every binding operation, for
 * the interface summary an import produces.
 *
 * @param definition the imported definition
 */
export function summarizeWsa(definition: WsdlDefinition): WsaSummary {
  let enabled = false;
  let optional = false;
  const versions: WsaVersion[] = [];
  const defaultActionByOperation: Record<string, string> = {};
  for (const binding of definition.bindings) {
    const portType = findPortType(definition, binding.type);
    for (const operation of binding.operations) {
      const detected = detectWsaDefaults(definition, binding, operation);
      if (detected.usingAddressing) {
        enabled = true;
        versions.push(detected.version);
      } else if (detected.optional === true) {
        optional = true;
      }
      const abstract = portType?.operations.find((candidate) => candidate.name === operation.name);
      if (portType !== undefined && abstract !== undefined) {
        defaultActionByOperation[wsaActionKey(binding.name, operation.name)] = defaultAction(
          definition,
          portType,
          abstract,
          {
            ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
          },
        );
      }
    }
  }
  return {
    enabled,
    optional,
    version: versions.length > 0 && versions.every((v) => v === '2004/08') ? '2004/08' : '2005/08',
    defaultActionByOperation,
  };
}
