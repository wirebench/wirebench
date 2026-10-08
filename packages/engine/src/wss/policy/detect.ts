/**
 * Reads a WSDL's WS-SecurityPolicy for one binding operation, the way `wsa/policy-detect.ts`
 * reads its WS-Addressing markers.
 *
 * Policies attach where WS-PolicyAttachment for WSDL 1.1 puts them — the binding and its ports
 * (endpoint policy), the binding operation (operation policy) and the operation's `wsdl:input`
 * (message policy) — inline, through `wsp:PolicyReference URI="#id"`, or through a
 * `wsp:PolicyURIs` attribute. The three levels are merged, as WS-Policy merges them. Of a
 * `wsp:ExactlyOne` only the first alternative is read, and the summary says so.
 */

import type { Document, Element } from '@xmldom/xmldom';
import { NS } from '../../xml/namespaces.js';
import type { Binding, BindingOperation, WsdlDefinition } from '../../wsdl/model.js';
import { qnameEquals } from '../../wsdl/qname.js';
import { wsaActionKey } from '../../wsa/policy-detect.js';
import type { WssPolicy, WssPolicyKeyReference, WssPolicyPart, WssPolicyToken, WssPolicyTokenRole } from './model.js';

const POLICY_NAMESPACES: readonly string[] = [NS.WSP, NS.WSP_2004];
const SP_NAMESPACES: readonly string[] = [NS.SP, NS.SP_2005];

/** The supporting-token assertions, by local name, and the role their tokens play. */
const SUPPORTING: Readonly<Record<string, WssPolicyTokenRole>> = {
  SupportingTokens: 'supporting',
  SignedSupportingTokens: 'signed-supporting',
  SignedEncryptedSupportingTokens: 'signed-supporting',
  EncryptedSupportingTokens: 'supporting',
  EndorsingSupportingTokens: 'endorsing',
  EndorsingEncryptedSupportingTokens: 'endorsing',
  SignedEndorsingSupportingTokens: 'signed-endorsing',
  SignedEndorsingEncryptedSupportingTokens: 'signed-endorsing',
};

/** The X.509 reference assertions, in the order a policy's choice is read. */
const REFERENCES: readonly (readonly [string, WssPolicyKeyReference])[] = [
  ['RequireThumbprintReference', 'Thumbprint'],
  ['RequireIssuerSerialReference', 'IssuerSerial'],
  ['RequireKeyIdentifierReference', 'SubjectKeyIdentifier'],
];

/** Assertions that may sit inside a supporting-tokens policy without being tokens themselves. */
const NOT_TOKENS: readonly string[] = [
  'SignedParts',
  'EncryptedParts',
  'SignedElements',
  'EncryptedElements',
  'AlgorithmSuite',
];

function isPolicyElement(element: Element, localName: string): boolean {
  return POLICY_NAMESPACES.includes(element.namespaceURI ?? '') && element.localName === localName;
}

function isSp(element: Element): boolean {
  return SP_NAMESPACES.includes(element.namespaceURI ?? '');
}

function childElements(element: Element): Element[] {
  const found: Element[] = [];
  for (let node = element.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      found.push(node as Element);
    }
  }
  return found;
}

function descendants(root: Element): Element[] {
  const found: Element[] = [];
  for (const child of childElements(root)) {
    found.push(child, ...descendants(child));
  }
  return found;
}

/** The `wsp:Policy` whose `wsu:Id`, `xml:id` or `Id` is `id`. */
function policyById(doc: Document, id: string): Element | undefined {
  const root = doc.documentElement;
  if (root === null) {
    return undefined;
  }
  return descendants(root).find(
    (element) =>
      isPolicyElement(element, 'Policy') &&
      [element.getAttributeNS(NS.WSU, 'Id'), element.getAttributeNS(NS.XML, 'id'), element.getAttribute('Id')].includes(
        id,
      ),
  );
}

/** What one detection pass collects besides the assertions themselves. */
interface Collector {
  readonly notes: Set<string>;
  /** Guards against a policy that references itself. */
  readonly visiting: Set<Element>;
}

/** Follows one `URI`: a local `#id` is read, anything else is noted and left alone. */
function referenced(doc: Document | null, uri: string, collector: Collector): Element[] {
  if (doc === null || !uri.startsWith('#')) {
    collector.notes.add(`Policy reference "${uri}" is not in this document and was not read.`);
    return [];
  }
  const policy = policyById(doc, uri.slice(1));
  if (policy === undefined) {
    collector.notes.add(`Policy reference "${uri}" names no policy in this document.`);
    return [];
  }
  return assertionsOf(policy, collector);
}

/** True when `element` carries `wsp:Optional="true"` in either policy namespace. */
function isOptional(element: Element): boolean {
  return POLICY_NAMESPACES.some((ns) => ['true', '1'].includes(element.getAttributeNS(ns, 'Optional') ?? ''));
}

/**
 * The assertions of the first alternative of a policy expression, flattened: `wsp:Policy` and
 * `wsp:All` are read through, a `wsp:ExactlyOne` contributes its first member, and a reference
 * contributes what it points at. Assertions marked `wsp:Optional="true"` are skipped (the policy
 * also allows going without them) and noted.
 */
function assertionsOf(expression: Element, collector: Collector): Element[] {
  if (collector.visiting.has(expression)) {
    return [];
  }
  collector.visiting.add(expression);
  const found: Element[] = [];
  for (const child of childElements(expression)) {
    if (isPolicyElement(child, 'Policy') || isPolicyElement(child, 'All')) {
      found.push(...assertionsOf(child, collector));
    } else if (isPolicyElement(child, 'ExactlyOne')) {
      const alternatives = childElements(child);
      if (alternatives.length > 1) {
        collector.notes.add(`The policy offers ${String(alternatives.length)} alternatives; the first one is used.`);
      }
      const first = alternatives[0];
      if (first !== undefined) {
        found.push(
          ...(isPolicyElement(first, 'All') || isPolicyElement(first, 'Policy')
            ? assertionsOf(first, collector)
            : [first]),
        );
      }
    } else if (isPolicyElement(child, 'PolicyReference')) {
      found.push(...referenced(expression.ownerDocument, child.getAttribute('URI') ?? '', collector));
    } else if (isOptional(child)) {
      if (isSp(child)) {
        collector.notes.add(`The optional sp:${child.localName ?? ''} assertion was left out.`);
      }
    } else {
      found.push(child);
    }
  }
  collector.visiting.delete(expression);
  return found;
}

/** The assertions attached to one WSDL element: its policy children and its `wsp:PolicyURIs`. */
function attachedTo(owner: Element, collector: Collector): Element[] {
  const found: Element[] = [];
  for (const child of childElements(owner)) {
    if (isPolicyElement(child, 'Policy')) {
      found.push(...assertionsOf(child, collector));
    } else if (isPolicyElement(child, 'PolicyReference')) {
      found.push(...referenced(owner.ownerDocument, child.getAttribute('URI') ?? '', collector));
    }
  }
  for (const ns of POLICY_NAMESPACES) {
    const uris = owner.getAttributeNS(ns, 'PolicyURIs') ?? '';
    for (const uri of uris.split(/\s+/).filter((candidate) => candidate.length > 0)) {
      found.push(...referenced(owner.ownerDocument, uri, collector));
    }
  }
  return found;
}

/** The WS-SecurityPolicy assertions inside an assertion's own nested `wsp:Policy`. */
function nested(assertion: Element, collector: Collector): Element[] {
  return childElements(assertion)
    .filter((child) => isPolicyElement(child, 'Policy'))
    .flatMap((policy) => assertionsOf(policy, collector))
    .filter(isSp);
}

/** The mutable summary a detection pass fills in. */
interface Draft {
  version: '1.1' | '1.2';
  binding: WssPolicy['binding'];
  requiresTls: boolean;
  includeTimestamp: boolean;
  encryptBeforeSigning: boolean;
  algorithmSuite?: string;
  readonly tokens: WssPolicyToken[];
  readonly signedParts: WssPolicyPart[];
  readonly encryptedParts: WssPolicyPart[];
  readonly unsupported: Set<string>;
  seen: boolean;
}

/** One token assertion (`sp:UsernameToken`, `sp:X509Token`, …) as a {@link WssPolicyToken}. */
function tokenOf(element: Element, role: WssPolicyTokenRole, draft: Draft, collector: Collector): WssPolicyToken {
  const inner = nested(element, collector);
  const has = (name: string): boolean => inner.some((assertion) => assertion.localName === name);
  const localName = element.localName ?? '';
  switch (localName) {
    case 'UsernameToken':
      return { kind: 'username', role, password: has('HashPassword') ? 'digest' : has('NoPassword') ? 'none' : 'text' };
    case 'X509Token':
      return { kind: 'x509', role, reference: REFERENCES.find(([name]) => has(name))?.[1] ?? 'BinarySecurityToken' };
    case 'IssuedToken': {
      const issuer = childElements(element).find((child) => isSp(child) && child.localName === 'Issuer');
      const address = issuer === undefined ? undefined : descendants(issuer).find((e) => e.localName === 'Address');
      const text = address?.textContent?.trim() ?? '';
      return { kind: 'issued', role, ...(text.length > 0 ? { issuer: text } : {}) };
    }
    case 'SamlToken':
      return { kind: 'saml', role };
    case 'KerberosToken':
      draft.unsupported.add('A Kerberos token inside the WS-Security header is not offered.');
      return { kind: 'kerberos', role };
    default:
      draft.unsupported.add(`The sp:${localName} token is not offered.`);
      return { kind: 'other', role, name: localName };
  }
}

/** `sp:SignedParts`/`sp:EncryptedParts` contents as parts, in the binding's SOAP namespace. */
function partsOf(element: Element, soapNamespace: string, draft: Draft): WssPolicyPart[] {
  const parts: WssPolicyPart[] = [];
  const list = `sp:${element.localName ?? ''}`;
  for (const child of childElements(element).filter(isSp)) {
    if (child.localName === 'Body') {
      parts.push({ name: 'Body', namespace: soapNamespace });
    } else if (child.localName === 'Header') {
      const name = child.getAttribute('Name') ?? '';
      const namespace = child.getAttribute('Namespace') ?? '';
      if (name.length === 0) {
        draft.unsupported.add(`${list} covers every header in "${namespace}"; a configuration names them one by one.`);
      } else {
        parts.push({ name, namespace });
      }
    } else if (child.localName === 'Attachments') {
      draft.unsupported.add(`${list} covers attachments, which are not signed or encrypted.`);
    }
  }
  return parts;
}

function pushUnique(target: WssPolicyPart[], parts: readonly WssPolicyPart[]): void {
  for (const part of parts) {
    if (!target.some((existing) => existing.name === part.name && existing.namespace === part.namespace)) {
      target.push(part);
    }
  }
}

/** Reads one security binding's nested policy: tokens, suite, timestamp, ordering. */
function readBinding(assertion: Element, draft: Draft, collector: Collector): void {
  for (const inner of nested(assertion, collector)) {
    switch (inner.localName) {
      case 'TransportToken':
        if (nested(inner, collector).some((token) => token.localName === 'HttpsToken')) {
          draft.requiresTls = true;
        }
        break;
      case 'InitiatorToken':
      case 'InitiatorSignatureToken':
      case 'InitiatorEncryptionToken':
      case 'RecipientToken':
      case 'RecipientSignatureToken':
      case 'RecipientEncryptionToken':
      case 'ProtectionToken': {
        const role = inner.localName.startsWith('Initiator') ? 'initiator' : 'recipient';
        for (const token of nested(inner, collector)) {
          draft.tokens.push(tokenOf(token, role, draft, collector));
        }
        break;
      }
      case 'AlgorithmSuite': {
        const suite = nested(inner, collector)[0]?.localName;
        if (suite !== undefined && suite !== null) {
          draft.algorithmSuite = suite;
        }
        break;
      }
      case 'IncludeTimestamp':
        draft.includeTimestamp = true;
        break;
      case 'EncryptBeforeSigning':
        draft.encryptBeforeSigning = true;
        break;
      case 'EncryptSignature':
        draft.unsupported.add('Encrypting the signature (sp:EncryptSignature) is not offered.');
        break;
      default:
        break;
    }
  }
}

const BINDING_KINDS: Readonly<Record<string, WssPolicy['binding']>> = {
  TransportBinding: 'transport',
  AsymmetricBinding: 'asymmetric',
  SymmetricBinding: 'symmetric',
};

/** Folds one top-level assertion into the draft. */
function readAssertion(assertion: Element, soapNamespace: string, draft: Draft, collector: Collector): void {
  if (!isSp(assertion)) {
    return;
  }
  draft.seen = true;
  if (assertion.namespaceURI === NS.SP_2005) {
    draft.version = '1.1';
  }
  const name = assertion.localName ?? '';
  const role = SUPPORTING[name];
  if (role !== undefined) {
    for (const token of nested(assertion, collector)) {
      if (!NOT_TOKENS.includes(token.localName ?? '')) {
        draft.tokens.push(tokenOf(token, role, draft, collector));
      }
    }
    return;
  }
  const kind = BINDING_KINDS[name];
  if (kind !== undefined) {
    if (draft.binding === 'none') {
      draft.binding = kind;
    }
    if (kind === 'symmetric') {
      draft.unsupported.add(
        'The symmetric binding (a shared, derived key) is not offered; only asymmetric signing and encryption are.',
      );
    }
    readBinding(assertion, draft, collector);
    return;
  }
  switch (name) {
    case 'SignedParts':
      pushUnique(draft.signedParts, partsOf(assertion, soapNamespace, draft));
      break;
    case 'EncryptedParts':
      pushUnique(draft.encryptedParts, partsOf(assertion, soapNamespace, draft));
      break;
    case 'SignedElements':
    case 'EncryptedElements':
    case 'ContentEncryptedElements':
    case 'RequiredElements':
      draft.unsupported.add(`sp:${name} names its parts by XPath, which a configuration cannot express.`);
      break;
    default:
      break;
  }
}

/** The binding operation's element and its `wsdl:input`, found under the binding's own element. */
function operationElements(binding: Binding, operation: BindingOperation): Element[] {
  const element = binding.sourceElement;
  if (element === undefined) {
    return [];
  }
  const op = childElements(element).find(
    (child) =>
      child.namespaceURI === NS.WSDL &&
      child.localName === 'operation' &&
      child.getAttribute('name') === operation.name,
  );
  if (op === undefined) {
    return [];
  }
  const input = childElements(op).find((child) => child.namespaceURI === NS.WSDL && child.localName === 'input');
  return input === undefined ? [op] : [op, input];
}

/**
 * The effective WS-SecurityPolicy for one binding operation, or `undefined` when no
 * WS-SecurityPolicy assertion applies to it.
 *
 * @param definition the imported definition
 * @param binding the binding the operation belongs to
 * @param operation the binding operation
 */
export function detectWssPolicy(
  definition: WsdlDefinition,
  binding: Binding,
  operation: BindingOperation,
): WssPolicy | undefined {
  const owners: Element[] = [
    ...(binding.sourceElement !== undefined ? [binding.sourceElement] : []),
    ...definition.services.flatMap((service) =>
      service.ports.flatMap((port) =>
        qnameEquals(port.binding, binding.name) && port.sourceElement !== undefined ? [port.sourceElement] : [],
      ),
    ),
    ...operationElements(binding, operation),
  ];
  const collector: Collector = { notes: new Set(), visiting: new Set() };
  const soapVersion = binding.soapVersion === '1.2' ? '1.2' : '1.1';
  const soapNamespace = soapVersion === '1.2' ? NS.SOAP12_ENV : NS.SOAP11_ENV;
  const draft: Draft = {
    version: '1.2',
    binding: 'none',
    requiresTls: false,
    includeTimestamp: false,
    encryptBeforeSigning: false,
    tokens: [],
    signedParts: [],
    encryptedParts: [],
    unsupported: new Set(),
    seen: false,
  };
  // A policy both the binding and a port reference is read once, not once per attachment.
  const read = new Set<Element>();
  for (const owner of owners) {
    for (const assertion of attachedTo(owner, collector)) {
      if (!read.has(assertion)) {
        read.add(assertion);
        readAssertion(assertion, soapNamespace, draft, collector);
      }
    }
  }
  if (!draft.seen) {
    return undefined;
  }
  return {
    version: draft.version,
    soapVersion,
    binding: draft.binding,
    requiresTls: draft.requiresTls,
    includeTimestamp: draft.includeTimestamp,
    encryptBeforeSigning: draft.encryptBeforeSigning,
    ...(draft.algorithmSuite !== undefined ? { algorithmSuite: draft.algorithmSuite } : {}),
    tokens: draft.tokens,
    signedParts: draft.signedParts,
    encryptedParts: draft.encryptedParts,
    unsupported: [...draft.unsupported],
    notes: [...collector.notes],
  };
}

/**
 * {@link detectWssPolicy} over every binding operation, keyed like the WS-Addressing default
 * actions (`{ns}Binding|Operation`); operations without a policy are left out.
 *
 * @param definition the imported definition
 */
export function summarizeWssPolicy(definition: WsdlDefinition): Readonly<Record<string, WssPolicy>> {
  const byOperation: Record<string, WssPolicy> = {};
  for (const binding of definition.bindings) {
    for (const operation of binding.operations) {
      const policy = detectWssPolicy(definition, binding, operation);
      if (policy !== undefined) {
        byOperation[wsaActionKey(binding.name, operation.name)] = policy;
      }
    }
  }
  return byOperation;
}
