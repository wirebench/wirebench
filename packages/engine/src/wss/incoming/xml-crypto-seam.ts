/**
 * The one place this build reaches into xml-crypto's private members.
 *
 * The debugger has to report the digest the *verifier* computed, not one a second canonicaliser
 * might compute slightly differently — a disagreement there would send a user chasing a fault that
 * does not exist. xml-crypto computes it in private methods, so they are named here, typed once,
 * and pinned by `xml-crypto-seam.test.ts`: an upgrade that renames them fails the build instead of
 * silently dropping the diagnosis.
 */

import type { Reference, SignedXml } from 'xml-crypto';
import type { Document, Element } from '@xmldom/xmldom';

/** What the debugger reads from a `SignedXml` after `loadSignature`/`checkSignature`. */
export interface SignedXmlInternals {
  /** The canonical form of a reference's node after its transforms. Needs `ref.xpath` set. */
  getCanonReferenceXml(doc: Document, ref: Reference, node: Element): string;
  findHashAlgorithm(name: string): { getHash(xml: string): string };
  /** The canonical `SignedInfo` of the loaded signature, against `doc`. */
  getCanonSignedInfoXml(doc: Document): string;
  findSignatureAlgorithm(name: string): { verifySignature(material: string, key: string, value: string): boolean };
  readonly signatureValue?: string;
  readonly signatureAlgorithm?: string;
  readonly canonicalizationAlgorithm?: string;
  readonly idAttributes: readonly string[];
}

/**
 * The internals of `verifier`.
 *
 * @param verifier a `SignedXml` that has loaded a signature
 * @returns the same object, viewed through the private members the debugger uses
 */
export function internalsOf(verifier: SignedXml): SignedXmlInternals {
  return verifier as unknown as SignedXmlInternals;
}
