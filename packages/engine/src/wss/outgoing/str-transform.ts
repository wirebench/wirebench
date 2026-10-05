/**
 * The STR-Transform (WSS SOAP Message Security 1.0 §8.3) for xml-crypto: a reference to a
 * `wsse:SecurityTokenReference` digests the token the STR points at, canonicalised with exc-c14n,
 * instead of the STR itself. That is how a signature covers a SAML assertion without giving the
 * assertion a `wsu:Id`, which would break its issuer's signature.
 *
 * xml-crypto emits `<ds:Transform Algorithm="…" />` with no children, but the STR-Transform needs
 * `wsse:TransformationParameters`. `registerStrTransform` wraps the instance's `createReferences`:
 * the string it returns is what SignedInfo is built, canonicalised and signed from, so the
 * parameters are inside the signature. Verification ignores the parameters (this transform always
 * applies exc-c14n), as xml-crypto's reference loader ignores a transform's unknown children.
 */
import { ExclusiveCanonicalization } from 'xml-crypto';
import type { SignedXml } from 'xml-crypto';
import type { Element, Node } from '@xmldom/xmldom';
import { NS } from '../../xml/namespaces.js';
import { STR_TRANSFORM } from '../saml/uris.js';

const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

/** Every element under (and including) `root` whose local name is `localName`, in document order. */
function elementsNamed(root: Node, localName: string): Element[] {
  const found: Element[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 1 && (node as Element).localName === localName) found.push(node as Element);
    for (let child = node.firstChild; child !== null; child = child.nextSibling) walk(child);
  };
  walk(root);
  return found;
}

/**
 * The id the STR names: a KeyIdentifier's text, or a `wsse:Reference`'s `#id`.
 *
 * @throws Error when the STR names nothing this build can dereference (including an empty id)
 */
export function referencedId(str: Element): string {
  const identifier = elementsNamed(str, 'KeyIdentifier')[0];
  let id = '';
  if (identifier !== undefined) {
    id = (identifier.textContent ?? '').trim();
  } else {
    const reference = elementsNamed(str, 'Reference')[0];
    // xmldom 0.8 answers '' for an absent attribute, so absence is asked for explicitly.
    const uri = reference?.hasAttribute('URI') === true ? reference.getAttribute('URI') : null;
    if (uri !== null && uri.startsWith('#')) id = uri.slice(1);
  }
  if (id === '') throw new Error('The SecurityTokenReference names no token this build can dereference.');
  return id;
}

/** Every assertion in `doc` whose `ID`/`AssertionID`/`wsu:Id` is `id`, in document order. */
export function assertionsWithId(doc: Node, id: string): Element[] {
  return elementsNamed(doc, 'Assertion').filter(
    (assertion) =>
      (assertion.hasAttribute('ID') && assertion.getAttribute('ID') === id) ||
      (assertion.hasAttribute('AssertionID') && assertion.getAttribute('AssertionID') === id) ||
      (assertion.hasAttributeNS(NS.WSU, 'Id') && assertion.getAttributeNS(NS.WSU, 'Id') === id),
  );
}

/** The one assertion in `doc` whose id is `id`; more than one is an attack. */
function dereference(doc: Node, id: string): Element {
  const matches = assertionsWithId(doc, id);
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) {
    throw new Error(`The SecurityTokenReference matches ${String(matches.length)} tokens, not one.`);
  }
  return only;
}

/**
 * The STR-Transform. xml-crypto hands `process` a deep clone of the referenced STR; the clone keeps
 * its `ownerDocument`, so the token is looked up in the live document the signature covers.
 *
 * Shaped as xml-crypto's `CanonicalizationOrTransformationAlgorithm` without declaring it: that
 * interface is typed against xml-crypto's own (older) xmldom `Node`, not the one this package uses.
 */
export class StrTransform {
  process(node: Node, options: Record<string, unknown>): string {
    const doc = (node as Element).ownerDocument;
    if (doc === null) throw new Error('The SecurityTokenReference is not in a document.');
    const token = dereference(doc, referencedId(node as Element));
    return new ExclusiveCanonicalization().process(token as never, {
      ...options,
      inclusiveNamespacesPrefixList: [],
      ancestorNamespaces: [],
    });
  }

  getAlgorithmName(): string {
    return STR_TRANSFORM;
  }
}

const PARAMETERS =
  `<wsse:TransformationParameters xmlns:wsse="${NS.WSSE}">` +
  `<ds:CanonicalizationMethod xmlns:ds="${NS.DS}" Algorithm="${EXC_C14N}"/></wsse:TransformationParameters>`;

/** Registers {@link StrTransform} on `signed`, and gives every STR-Transform it emits its parameters. */
export function registerStrTransform(signed: SignedXml): void {
  (signed.CanonicalizationAlgorithms as Record<string, unknown>)[STR_TRANSFORM] = StrTransform;
  const target = signed as unknown as { createReferences: (doc: unknown, prefix?: string) => string };
  const original = target.createReferences.bind(signed);
  target.createReferences = (doc, prefix) => {
    // xml-crypto 6 passes the bare prefix ('ds') and adds the colon itself.
    const qualified = prefix !== undefined && prefix !== '' ? `${prefix}:` : '';
    const emitted = original(doc, prefix);
    const replaced = emitted.replaceAll(
      `<${qualified}Transform Algorithm="${STR_TRANSFORM}" />`,
      `<${qualified}Transform Algorithm="${STR_TRANSFORM}">${PARAMETERS}</${qualified}Transform>`,
    );
    // A transform xml-crypto wrote in a shape the replacement does not know would go out without
    // its parameters, silently; refuse instead.
    if (replaced === emitted && emitted.includes(`Algorithm="${STR_TRANSFORM}"`)) {
      throw new Error('The STR-Transform was emitted in a form that could not be given its parameters.');
    }
    return replaced;
  };
}
