/**
 * XML Signature for an outgoing WS-Security header, on top of `xml-crypto`'s `SignedXml`.
 *
 * `xml-crypto` only speaks serialized XML: it parses the string it is given, adds the
 * `<ds:Signature>` and hands back a new string. {@link signEnvelope} therefore serializes the
 * document it is given, signs, re-parses and swaps the result into the *same* `Document`
 * object — so the caller's reference stays valid, at the cost of every `Element` it held
 * before the call becoming stale. `applyOutgoingWss` re-resolves the `wsse:Security` block
 * after each signature entry for exactly that reason.
 */

import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import type { Document, Element } from '@xmldom/xmldom';
import { WssError } from '../../errors.js';
import { NS } from '../../xml/namespaces.js';
import { parseXml } from '../../xml/parse.js';
import { serializeXml } from '../../xml/serialize.js';
import { detectEnvelopeVersion, envelopeNamespace } from '../../soap/envelope.js';
import { buildKeyIdentifier, samlTokenReference, thumbprintSha1Base64 } from '../key-identifiers.js';
import type { KeyIdentifier } from '../key-identifiers.js';
import { inclusiveNamespacePrefixList } from '../c14n-prefixes.js';
import { childElement, findElement, securityIndex } from '../security-header.js';
import type { Keystore, KeystoreAlias } from '../../keystore/model.js';
import type { PlacedSamlToken } from './saml.js';
import { assertionsWithId, referencedId, registerStrTransform } from './str-transform.js';
import { STR_TRANSFORM } from '../saml/uris.js';
import type { WssContext, WssPart, WssSignatureEntry } from '../model.js';

/** Exclusive XML canonicalization, the only form this build emits. */
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

/** `SignatureMethod` URIs, by the entry's `signatureAlgorithm`. */
const SIGNATURE_ALGORITHM_URIS = {
  'rsa-sha256': 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  'rsa-sha1': 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
} as const;

/** `DigestMethod` URIs, by the entry's `digestAlgorithm`. */
const DIGEST_ALGORITHM_URIS = {
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
} as const;

/** The keystore material {@link signEnvelope} signs with, resolved by the caller. */
export interface ResolvedSigningKey {
  readonly keystore: Keystore;
  readonly alias: KeystoreAlias;
  /** The actor/role of the `wsse:Security` block the signature belongs in. */
  readonly actor?: string;
  /** SAML tokens placed before this signature, in order (a `saml-token` key identifier refers to the nearest). */
  readonly placedTokens?: readonly PlacedSamlToken[];
}

/** The outcome of {@link verifySignature}. */
export interface VerifySignatureResult {
  readonly ok: boolean;
  /** The `URI`s the signature's references pointed at, without their leading `#`. */
  readonly references: readonly string[];
  /** Why verification failed; absent when `ok`. */
  readonly error?: string;
}

/** What {@link verifySignature} needs to check a signature. */
export interface VerifySignatureOptions {
  /** The signer's certificate, PEM encoded. */
  readonly certPem: string;
  /**
   * Which `ds:Signature` to verify, when `xml` carries more than one. `index` counts among every
   * `ds:Signature` element in the document, in document order (depth-first, pre-order) — the
   * same order {@link findAllSignatures} and `verifyIncoming`'s own signature list use, so the
   * two never disagree about which signature `index` names. Defaults to `0` (the first).
   *
   * Selecting by index against the *unmodified* document — rather than stripping every other
   * `ds:Signature` before verifying — matters because a genuine signature's own references can
   * cover the `wsse:Security` header (an enveloped-signature transform over a header that holds
   * a second signature): removing that second signature before verification would change the
   * bytes the first signature's digest was computed over, and it would fail.
   */
  readonly signature?: { readonly index: number };
}

/** True when `element` already carries a `wsu:Id`. */
function existingWsuId(element: Element): string | undefined {
  const value = element.getAttributeNS(NS.WSU, 'Id');
  return value === null || value === '' ? undefined : value;
}

/**
 * The element a part names. The two SOAP envelope namespaces are treated as one so the default
 * parts (which store the SOAP 1.1 namespace for `Body`) also match a SOAP 1.2 envelope.
 */
function resolvePart(root: Element, part: WssPart, envelopeNs: string): Element | undefined {
  const namespace = part.namespace === NS.SOAP11_ENV || part.namespace === NS.SOAP12_ENV ? envelopeNs : part.namespace;
  return findElement(root, namespace, part.name);
}

/** The private key of `alias`, decrypted with `passphrase` when its PEM needs one. */
export function privateKeyOf(alias: KeystoreAlias, passphrase: string | undefined): KeyObject {
  const keyPem = alias.keyPem;
  if (keyPem === undefined || keyPem === '') {
    throw new WssError('wss-signing-key-missing', `Keystore alias "${alias.alias}" has no private key to sign with.`);
  }
  try {
    return createPrivateKey(keyPem);
  } catch (cause) {
    if (passphrase === undefined) {
      throw new WssError('wss-signing-key-missing', 'The signing key could not be read.', { cause });
    }
    try {
      return createPrivateKey({ key: keyPem, passphrase });
    } catch (innerCause) {
      throw new WssError('wss-signing-key-missing', 'The signing key could not be decrypted.', { cause: innerCause });
    }
  }
}

/**
 * The SAML token placed most recently before this signature entry.
 *
 * @throws WssError `wss-saml-token-missing` when there is none, `wss-proof-key-mismatch` when a
 * holder-of-key token binds a certificate other than the signing one
 */
function nearestToken(resolved: ResolvedSigningKey, signingCertPem: string): PlacedSamlToken {
  const token = resolved.placedTokens?.at(-1);
  if (token === undefined) {
    throw new WssError(
      'wss-saml-token-missing',
      'This signature refers to a SAML token, but no SAML entry comes before it.',
    );
  }
  if (
    token.confirmation === 'holder-of-key' &&
    token.proofCertPem !== undefined &&
    thumbprintSha1Base64(token.proofCertPem) !== thumbprintSha1Base64(signingCertPem)
  ) {
    throw new WssError('wss-proof-key-mismatch', 'A holder-of-key SAML token must be signed with its proof key.');
  }
  return token;
}

/**
 * Checks, before xml-crypto runs, that the STR names exactly one assertion in `doc`, by the rule
 * the STR-Transform itself dereferences with: inside xml-crypto a failure there is a plain Error.
 *
 * @throws WssError `wss-saml-token-missing` when the STR names no id or the id matches ≠ 1 assertions
 */
function assertTokenResolvable(doc: Document, str: Element): void {
  let id: string;
  try {
    id = referencedId(str);
  } catch (cause) {
    throw new WssError(
      'wss-saml-token-missing',
      'The SAML token reference names no assertion this build can sign over.',
      { cause },
    );
  }
  const count = assertionsWithId(doc, id).length;
  if (count !== 1) {
    throw new WssError(
      'wss-saml-token-missing',
      `The SAML token reference matches ${String(count)} assertions in the message, not one.`,
      { details: { id, matches: count } },
    );
  }
}

/**
 * Signs the parts `entry` names and appends the `<ds:Signature>` to the `wsse:Security` block
 * addressed to `resolved.actor`, mutating `doc` in place.
 *
 * Every referenced part is given a `wsu:Id="Id-<uuid>"` first (existing ids are kept), so the
 * references are stable and `xml-crypto` never has to invent one.
 *
 * @param doc the envelope, already carrying its `wsse:Security` header
 * @param entry the signature configuration
 * @param resolved the keystore alias to sign with, and the Security block's actor
 * @param ctx the injected secret/uuid capabilities
 * @throws WssError `wss-not-an-envelope`, `wss-part-missing`, `wss-ski-missing`, `wss-signing-key-missing`,
 * `wss-saml-token-missing`, `wss-proof-key-mismatch`
 */
export async function signEnvelope(
  doc: Document,
  entry: WssSignatureEntry,
  resolved: ResolvedSigningKey,
  ctx: WssContext,
): Promise<void> {
  const root = doc.documentElement;
  const version = detectEnvelopeVersion(doc);
  if (root === null || version === undefined) {
    throw new WssError('wss-not-an-envelope', 'WS-Security can only be applied to a SOAP envelope.');
  }
  const envelopeNs = envelopeNamespace(version);
  const header = childElement(root, envelopeNs, 'Header');
  const security = header === undefined ? undefined : findElement(header, NS.WSSE, 'Security');
  if (header === undefined || security === undefined) {
    throw new WssError('wss-not-an-envelope', 'The envelope has no wsse:Security header to sign into.');
  }

  const references: { readonly id: string; readonly element: Element }[] = [];
  const strReferences: string[] = [];
  for (const part of entry.parts) {
    if (part.token === true) {
      // The assertion itself is never given a wsu:Id: an STR naming it is, and the STR-Transform
      // digests the assertion through it.
      const token = nearestToken(resolved, resolved.alias.certPem);
      const strId = `STR-${ctx.uuid()}`;
      const str = parseXml(samlTokenReference(token, { id: strId }), { location: 'envelope' }).documentElement;
      if (str !== null) {
        assertTokenResolvable(doc, str);
        security.appendChild(doc.importNode(str, true));
      }
      strReferences.push(strId);
      continue;
    }
    const element = resolvePart(root, part, envelopeNs);
    if (element === undefined) {
      throw new WssError('wss-part-missing', `The message has no "${part.name}" element to sign.`, {
        details: { name: part.name, namespace: part.namespace },
      });
    }
    let id = existingWsuId(element);
    if (id === undefined) {
      id = `Id-${ctx.uuid()}`;
      // Only declare `xmlns:wsu` here when no ancestor already binds the prefix to the WS-Utility
      // namespace (the `wsse:Security` block does, for every part it added itself) — redeclaring
      // it lower down is harmless to a parser but noise `verifySignature`/`xmlsec1` never asked for.
      if (element.lookupNamespaceURI('wsu') !== NS.WSU) {
        element.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:wsu', NS.WSU);
      }
      element.setAttributeNS(NS.WSU, 'wsu:Id', id);
    }
    references.push({ id, element });
  }

  const keyIdentifier: KeyIdentifier =
    entry.keyIdentifierType === 'saml-token'
      ? { keyInfoXml: samlTokenReference(nearestToken(resolved, resolved.alias.certPem)) }
      : buildKeyIdentifier(entry.keyIdentifierType, {
          certPem: resolved.alias.certPem,
          chainPem: resolved.alias.chainPem,
          useSingleCertificate: entry.useSingleCertificate,
          tokenId: `X509-${ctx.uuid()}`,
        });
  if (keyIdentifier.binarySecurityTokenXml !== undefined) {
    const token = parseXml(keyIdentifier.binarySecurityTokenXml, { location: 'envelope' }).documentElement;
    if (token !== null) {
      security.appendChild(doc.importNode(token, true));
    }
  }

  const passphrase = entry.keyPasswordRef === undefined ? undefined : await ctx.secrets(entry.keyPasswordRef);
  // The envelope's own prefix, needed on the SignedInfo canonicalization itself and on every
  // reference transform: exclusive c14n only renders a namespace declaration a part visibly
  // uses on an element/attribute *name*, so a receiver that canonicalizes a reference on its
  // own (rather than trusting this build's canonical form) needs it spelled out.
  const envPrefix = root.prefix;
  const signer = new SignedXml({
    idMode: 'wssecurity',
    privateKey: privateKeyOf(resolved.alias, passphrase),
    publicCert: resolved.alias.certPem,
    canonicalizationAlgorithm: EXC_C14N,
    inclusiveNamespacesPrefixList: envPrefix !== null && envPrefix !== '' ? [envPrefix] : [],
    signatureAlgorithm: SIGNATURE_ALGORITHM_URIS[entry.signatureAlgorithm],
    getKeyInfoContent: () => keyIdentifier.keyInfoXml,
  });
  for (const { id, element } of references) {
    signer.addReference({
      // By id rather than by element name: the id is unique, so this selects exactly the one
      // element even when the envelope carries two parts with the same local name.
      xpath: `//*[@*[local-name(.)='Id']='${id}']`,
      transforms: [EXC_C14N],
      digestAlgorithm: DIGEST_ALGORITHM_URIS[entry.digestAlgorithm],
      inclusiveNamespacesPrefixList: inclusiveNamespacePrefixList(element, envPrefix),
    });
  }
  if (strReferences.length > 0) registerStrTransform(signer);
  for (const id of strReferences) {
    signer.addReference({
      xpath: `//*[@*[local-name(.)='Id']='${id}']`,
      transforms: [STR_TRANSFORM],
      digestAlgorithm: DIGEST_ALGORITHM_URIS[entry.digestAlgorithm],
    });
  }
  // The index and the XPath must count the same node set — direct `wsse:Security` children of
  // the header — so a `wsse:Security` nested elsewhere (inside the Body, say) never shifts
  // which block xml-crypto appends the signature into. `securityIndex` throws when no direct
  // child matches, so `index` is never used to build an XPath that resolves to nothing.
  const index = securityIndex(header, version, resolved.actor);
  signer.computeSignature(serializeXml(doc), {
    prefix: 'ds',
    location: {
      reference:
        `/*[local-name()='Envelope']/*[local-name()='Header']` +
        `/*[local-name()='Security' and namespace-uri()='${NS.WSSE}'][${index}]`,
      action: 'append',
    },
  });
  const signed = parseXml(signer.getSignedXml(), { location: 'envelope' });
  const next = signed.documentElement;
  if (next !== null) {
    doc.replaceChild(doc.importNode(next, true), root);
  }
}

/** Every `ds:Signature` element under `root`, in document order (depth-first, pre-order). */
function findAllSignatures(root: Element): Element[] {
  const found: Element[] = [];
  const walk = (node: Element): void => {
    if (node.namespaceURI === NS.DS && node.localName === 'Signature') {
      found.push(node);
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

/** The `URI`s of a signature's `ds:Reference` children, without their leading `#`. */
function referenceUris(signature: Element): string[] {
  const signedInfo = childElement(signature, NS.DS, 'SignedInfo');
  if (signedInfo === undefined) {
    return [];
  }
  const uris: string[] = [];
  for (let node = signedInfo.firstChild; node !== null; node = node.nextSibling) {
    const element = node as Element;
    if (element.nodeType === 1 && element.namespaceURI === NS.DS && element.localName === 'Reference') {
      const uri = element.getAttribute('URI') ?? '';
      uris.push(uri.startsWith('#') ? uri.slice(1) : uri);
    }
  }
  return uris;
}

/**
 * Verifies the `ds:Signature` in `xml` against `certPem`.
 *
 * The certificate is supplied by the caller rather than taken from the document's own
 * `KeyInfo`: a signature is only meaningful against a key you already trust.
 *
 * @param xml the signed envelope
 * @param options the certificate to verify against
 * @returns whether the signature held, and which references it covered
 */
export function verifySignature(xml: string, options: VerifySignatureOptions): VerifySignatureResult {
  let signature: Element | undefined;
  try {
    const root = parseXml(xml, { location: 'envelope' }).documentElement;
    const signatures = root === null ? [] : findAllSignatures(root);
    signature = signatures[options.signature?.index ?? 0];
  } catch (error) {
    return { ok: false, references: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (signature === undefined) {
    return { ok: false, references: [], error: 'The document carries no ds:Signature element.' };
  }
  const references = referenceUris(signature);
  const verifier = new SignedXml({
    idMode: 'wssecurity',
    publicCert: options.certPem,
    // Trust the caller's certificate, never the one the document brought with it.
    getCertFromKeyInfo: () => null,
  });
  // Does nothing to a signature without an STR-Transform reference.
  registerStrTransform(verifier);
  try {
    verifier.loadSignature(serializeXml(signature));
    const ok = verifier.checkSignature(xml);
    return ok ? { ok, references } : { ok, references, error: 'One or more references failed validation.' };
  } catch (error) {
    return { ok: false, references, error: error instanceof Error ? error.message : String(error) };
  }
}
