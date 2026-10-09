/**
 * The debugger's view of one `ds:Signature`: every reference with its expected and computed
 * digest and the transforms that produced it, and whether the `SignatureValue` itself holds.
 *
 * xml-crypto stops at the first reference that fails and reports it as a sentence; a user with a
 * failed signature needs to know *which* part changed, and whether the payload changed or the key
 * is wrong. This recomputes every reference with xml-crypto's own canonicaliser (through
 * `xml-crypto-seam.ts`), so the computed digest shown is exactly the one the verifier compared.
 */

import type { Reference, SignedXml } from 'xml-crypto';
import type { Document, Element } from '@xmldom/xmldom';
import { parseXml } from '../../xml/parse.js';
import { STR_TRANSFORM } from '../saml/uris.js';
import { internalsOf } from './xml-crypto-seam.js';

/** One `ds:Reference`, as the debugger reports it. */
export interface WssReferenceCheck {
  /** The reference `URI`, without its leading `#`. */
  readonly uri: string;
  /** The local name of the element the URI resolves to; absent when it resolves to none. */
  readonly element?: string;
  readonly ok: boolean;
  /** The reference's transforms, by short name (`exc-c14n`, `enveloped-signature`, …) or URI. */
  readonly transforms: readonly string[];
  /** The `InclusiveNamespaces PrefixList` of an exclusive canonicalisation, when it has one. */
  readonly inclusivePrefixes: readonly string[];
  /** `sha1`, `sha256`, `sha512`, or the URI of anything else. */
  readonly digestAlgorithm: string;
  /** The `DigestValue` the message carries, base64. */
  readonly expectedDigest: string;
  /** The digest computed over the message as it arrived, base64; absent when none could be. */
  readonly computedDigest?: string;
  /** Why there is no computed digest. */
  readonly problem?: string;
}

/** One `ds:Signature`, as the debugger reports it. */
export interface WssSignatureCheck {
  /** The `SignedInfo` canonicalisation, by short name or URI. */
  readonly canonicalization: string;
  /** `rsa-sha256`, `rsa-sha1`, `rsa-sha512`, or the URI of anything else. */
  readonly signatureMethod: string;
  readonly references: readonly WssReferenceCheck[];
  /** The `SignatureValue` verifies over the canonical `SignedInfo` with the signer's key. */
  readonly signatureValueOk: boolean;
}

const SHORT_NAMES: Readonly<Record<string, string>> = {
  'http://www.w3.org/2001/10/xml-exc-c14n#': 'exc-c14n',
  'http://www.w3.org/2001/10/xml-exc-c14n#WithComments': 'exc-c14n#WithComments',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315': 'c14n',
  'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments': 'c14n#WithComments',
  'http://www.w3.org/2000/09/xmldsig#enveloped-signature': 'enveloped-signature',
  [STR_TRANSFORM]: 'str-transform',
  'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1',
  'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512',
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'rsa-sha1',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'rsa-sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'rsa-sha512',
};

/**
 * The short name of an XML Signature algorithm URI, or the URI itself when it has none.
 *
 * @param uri an algorithm URI
 * @returns e.g. `exc-c14n`, `sha256`, `rsa-sha256`
 */
export function algorithmName(uri: string | undefined): string {
  if (uri === undefined || uri === '') {
    return 'unknown';
  }
  return SHORT_NAMES[uri] ?? uri;
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every element under `root` carrying `value` in one of `attributes` (any namespace). */
function elementsWithId(root: Element, attributes: readonly string[], value: string): Element[] {
  const found: Element[] = [];
  const walk = (node: Element): void => {
    for (let position = 0; position < node.attributes.length; position += 1) {
      const attribute = node.attributes.item(position);
      if (attribute !== null && attributes.includes(attribute.localName ?? '') && attribute.value === value) {
        found.push(node);
        break;
      }
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 1) {
        walk(child as Element);
      }
    }
  };
  walk(root);
  return found;
}

/** Which of `attributes` carries `value` on `element` — the name xml-crypto's XPath selects by. */
function idAttributeOf(element: Element, attributes: readonly string[], value: string): string | undefined {
  return attributes.find((name) => {
    for (let position = 0; position < element.attributes.length; position += 1) {
      const candidate = element.attributes.item(position);
      if (candidate?.localName === name && candidate.value === value) return true;
    }
    return false;
  });
}

/** The base64 form of a `DigestValue` as xml-crypto holds it. */
function digestText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : '';
}

/** A reference's report fields that do not depend on recomputing it. */
function describe(ref: Reference): Omit<WssReferenceCheck, 'ok' | 'element' | 'computedDigest' | 'problem'> {
  const uri = ref.uri.startsWith('#') ? ref.uri.slice(1) : ref.uri;
  return {
    uri,
    transforms: ref.transforms.map((transform) => algorithmName(transform)),
    inclusivePrefixes: [...ref.inclusiveNamespacesPrefixList],
    digestAlgorithm: algorithmName(ref.digestAlgorithm),
    expectedDigest: digestText(ref.digestValue),
  };
}

/** Recomputes one reference against `doc`, exactly as xml-crypto's `validateReference` does. */
function recompute(verifier: SignedXml, doc: Document, ref: Reference): WssReferenceCheck {
  const base = describe(ref);
  const internals = internalsOf(verifier);
  const root = doc.documentElement;
  if (root === null) {
    return { ...base, ok: false, problem: 'The message has no root element.' };
  }
  let node: Element | undefined;
  if (base.uri === '') {
    node = root;
    ref.xpath = '//*';
  } else {
    if (base.uri.includes("'")) {
      return { ...base, ok: false, problem: 'The reference URI contains a quote, which is not accepted.' };
    }
    const attributes = internals.idAttributes;
    const found = elementsWithId(root, attributes, base.uri);
    if (found.length > 1) {
      return { ...base, ok: false, problem: `More than one element carries the id "${base.uri}".` };
    }
    node = found[0];
    const attribute = node === undefined ? 'Id' : (idAttributeOf(node, attributes, base.uri) ?? 'Id');
    ref.xpath = `//*[@*[local-name(.)='${attribute}']='${base.uri}']`;
  }
  if (node === undefined) {
    return { ...base, ok: false, problem: 'No element in the message carries this id.' };
  }
  try {
    const canonical = internals.getCanonReferenceXml(doc, ref, node);
    const computedDigest = internals.findHashAlgorithm(ref.digestAlgorithm).getHash(canonical);
    return {
      ...base,
      element: node.localName ?? '',
      ok: computedDigest === base.expectedDigest,
      computedDigest,
    };
  } catch (error) {
    return { ...base, element: node.localName ?? '', ok: false, problem: messageOf(error) };
  }
}

/** Whether the loaded `SignatureValue` verifies over the canonical `SignedInfo` of `doc`. */
function signatureValueHolds(verifier: SignedXml, doc: Document, certPem: string): boolean {
  const internals = internalsOf(verifier);
  try {
    const canonical = internals.getCanonSignedInfoXml(doc);
    return internals
      .findSignatureAlgorithm(internals.signatureAlgorithm ?? '')
      .verifySignature(canonical, certPem, internals.signatureValue ?? '');
  } catch {
    return false;
  }
}

/**
 * The debugger's report of the signature `verifier` has checked against `xml`.
 *
 * When the signature `passed`, every reference matched, so the expected digests are the computed
 * ones and nothing is recomputed. Otherwise every reference is recomputed against `xml` and the
 * `SignatureValue` is checked on its own, so a changed payload and a wrong key read differently.
 *
 * Never throws: a step that fails is reported as that reference's `problem`.
 *
 * @param verifier a `SignedXml` that has run `checkSignature(xml)`
 * @param xml the document the signature was checked against
 * @param certPem the certificate it was checked with
 * @param passed whether `checkSignature` reported success
 * @returns the per-reference and SignatureValue report
 */
export function signatureCheck(verifier: SignedXml, xml: string, certPem: string, passed: boolean): WssSignatureCheck {
  const internals = internalsOf(verifier);
  const header = {
    canonicalization: algorithmName(internals.canonicalizationAlgorithm),
    signatureMethod: algorithmName(internals.signatureAlgorithm),
  };
  const refs = verifier.getReferences();
  if (passed) {
    return {
      ...header,
      references: refs.map((ref) => {
        const base = describe(ref);
        return { ...base, ok: true, computedDigest: base.expectedDigest };
      }),
      signatureValueOk: true,
    };
  }
  let doc: Document;
  try {
    doc = parseXml(xml, { location: 'envelope' });
  } catch (error) {
    const problem = messageOf(error);
    return {
      ...header,
      references: refs.map((ref) => ({ ...describe(ref), ok: false, problem })),
      signatureValueOk: false,
    };
  }
  return {
    ...header,
    references: refs.map((ref) => recompute(verifier, doc, ref)),
    signatureValueOk: signatureValueHolds(verifier, doc, certPem),
  };
}
