/**
 * Verification of an *incoming* message: every `ds:Signature` in a `wsse:Security` header, and
 * the header's `wsu:Timestamp`.
 *
 * Two questions are answered separately, because they fail for different reasons and a user
 * has to be able to tell them apart:
 *
 * - **validity** — does the signature actually hold over the bytes that arrived? That is
 *   Task 38's {@link verifySignature}, run against the certificate the message's own `KeyInfo`
 *   points at.
 * - **trust** — is that certificate one we accept? A signature verifies perfectly against the
 *   key that made it, including a key an attacker owns, so the certificate is checked against
 *   the configured truststore: stored verbatim, or (with `verifyChain`) chaining to one of its
 *   certificates.
 *
 * `KeyInfo` is therefore a *hint* about which key to look up, never a source of trust.
 */

import forge from 'node-forge';
import type { Element } from '@xmldom/xmldom';
import { NS } from '../../xml/namespaces.js';
import { parseXml } from '../../xml/parse.js';
import { serializeXml } from '../../xml/serialize.js';
import { renderDn, renderDnRfc2253 } from '../keystore/certificate.js';
import {
  certificateBase64,
  subjectKeyIdentifierBase64,
  thumbprintSha1Base64,
  WSS_TOKEN_TYPES,
} from '../key-identifiers.js';
import { childElement, findElement } from '../security-header.js';
import { verifySignature } from '../outgoing/signature.js';
import type { Keystore } from '../keystore/model.js';

/** One `ds:Signature` as {@link verifyIncoming} judged it. */
export interface IncomingSignatureResult {
  /** The signature held over the bytes that arrived. */
  readonly ok: boolean;
  /** The `URI`s the signature's references covered, without their leading `#`. */
  readonly references: readonly string[];
  /** The local names of the covered elements, in reference order; the id when one is unresolvable. */
  readonly referenceNames: readonly string[];
  /** A valid reference covers the envelope's `Body`. `false` whenever that cannot be shown. */
  readonly coversBody: boolean;
  /** The signer's subject DN, when the certificate could be resolved at all. */
  readonly signerSubject?: string;
  /** The signer's certificate is in (or chains to) the truststore. */
  readonly trusted: boolean;
  /** Why the signature did not verify, or why its certificate could not be resolved. */
  readonly error?: string;
}

/** The `wsu:Timestamp` as {@link verifyIncoming} read it. */
export interface IncomingTimestampResult {
  /** `wsu:Created`, verbatim. */
  readonly created: string;
  /** `wsu:Expires`, verbatim; absent when the timestamp carries none. */
  readonly expires?: string;
  /** `Created - skew <= now <= Expires + skew` (or, with no `Expires`, `Created` within skew). */
  readonly fresh: boolean;
  /** Why the timestamp was rejected; absent when fresh. */
  readonly error?: string;
}

/** The outcome of {@link verifyIncoming}. */
export interface VerifyIncomingResult {
  readonly signatures: readonly IncomingSignatureResult[];
  /** Absent when the message carries no `wsu:Timestamp`. */
  readonly timestamp?: IncomingTimestampResult;
}

/** What {@link verifyIncoming} needs to judge a message. */
export interface VerifyIncomingOptions {
  /** Keystore whose aliases are the trusted certificates/CAs; without one nothing is trusted. */
  readonly truststore?: Keystore;
  readonly clock: () => Date;
  /** Clock skew tolerated on the timestamp, in seconds. */
  readonly skewSeconds: number;
  /** Accept a signer that chains to a truststore certificate, not only one stored verbatim. */
  readonly verifyChain: boolean;
}

/** Every descendant-or-self of `root` in `namespace` with local name `localName`, in document order. */
function findAll(root: Element, namespace: string, localName: string): Element[] {
  const found: Element[] = [];
  const walk = (node: Element): void => {
    if (node.namespaceURI === namespace && node.localName === localName) {
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

/**
 * Every element under `root` by the value of its `Id` attribute (in any namespace, or none),
 * built once per document.
 *
 * A *list* per id rather than the first match: a duplicated id is how a signature-wrapping
 * attack hides a second element behind a reference, so ambiguity has to be visible rather than
 * resolved by document order.
 */
function idIndex(root: Element): Map<string, Element[]> {
  const index = new Map<string, Element[]>();
  const walk = (node: Element): void => {
    for (let position = 0; position < node.attributes.length; position += 1) {
      const attribute = node.attributes.item(position);
      if (attribute !== null && attribute.localName === 'Id' && attribute.value !== '') {
        const found = index.get(attribute.value);
        if (found === undefined) {
          index.set(attribute.value, [node]);
        } else {
          found.push(node);
        }
      }
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (child.nodeType === 1) {
        walk(child as Element);
      }
    }
  };
  walk(root);
  return index;
}

/** The one element carrying `id`, or `undefined` when no element — or more than one — does. */
function uniqueById(index: ReadonlyMap<string, Element[]>, id: string): Element | undefined {
  const found = index.get(id);
  return found?.length === 1 ? found[0] : undefined;
}

/** The text of `element` with every whitespace character removed, so wrapped base64 compares. */
function textOf(element: Element | undefined): string {
  return element === undefined ? '' : (element.textContent ?? '').replace(/\s+/g, '');
}

/** A forge certificate from base64 DER, or `undefined` when the bytes are not one. */
function certificateFromBase64(value: string): forge.pki.Certificate | undefined {
  if (value === '') {
    return undefined;
  }
  try {
    const der = forge.util.createBuffer(Buffer.from(value, 'base64').toString('binary'));
    return forge.pki.certificateFromAsn1(forge.asn1.fromDer(der));
  } catch {
    return undefined;
  }
}

/**
 * The leaf of an `X509PKIPathv1` value: a DER `SEQUENCE OF Certificate`, leaf first (as
 * `pkiPathBase64` writes it). `undefined` when the bytes are not such a sequence.
 */
function certificateFromPkiPath(value: string): forge.pki.Certificate | undefined {
  try {
    const der = forge.util.createBuffer(Buffer.from(value, 'base64').toString('binary'));
    const sequence = forge.asn1.fromDer(der);
    const first = Array.isArray(sequence.value) ? sequence.value[0] : undefined;
    return first === undefined ? undefined : forge.pki.certificateFromAsn1(first);
  } catch {
    return undefined;
  }
}

/** A truststore certificate with the two renderings every comparison here needs, computed once. */
interface TrustedCertificate {
  readonly cert: forge.pki.Certificate;
  readonly pem: string;
  /** Base64 DER, so identity comparison is a string compare rather than a re-encode per candidate. */
  readonly der: string;
}

/**
 * Every certificate the truststore holds, parsed — and rendered to PEM and DER — once per call.
 * Re-deriving these per signature is what made a large truststore quadratic.
 */
function truststoreCertificates(truststore: Keystore | undefined): TrustedCertificate[] {
  if (truststore === undefined) {
    return [];
  }
  const certificates: TrustedCertificate[] = [];
  for (const alias of truststore.aliases) {
    for (const pem of [alias.certPem, ...alias.chainPem]) {
      try {
        const cert = forge.pki.certificateFromPem(pem);
        const normalized = forge.pki.certificateToPem(cert);
        certificates.push({ cert, pem: normalized, der: certificateBase64(normalized) });
      } catch {
        // A truststore entry this build cannot parse simply trusts nothing.
      }
    }
  }
  return certificates;
}

/** One RFC 2253 attribute: an attribute type (`CN`, `2.5.4.3`, …) and its unescaped value. */
interface DnAttribute {
  readonly type: string;
  readonly value: string;
}

/**
 * Parses an RFC 2253/4514 distinguished name into its attributes: split on unescaped `,` (and
 * `+`, which joins a multi-valued RDN), then on the first unescaped `=`, unescaping `\x` and
 * `\XX` hex pairs in the value.
 *
 * Needed because an `X509IssuerName` is only *semantically* equal to the DN this build renders:
 * a peer is free to space, order and escape it differently, and comparing the rendered strings
 * would reject a certificate we do hold.
 */
function parseRfc2253(dn: string): DnAttribute[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < dn.length; index += 1) {
    const char = dn.charAt(index);
    if (char === '\\') {
      current += char + dn.charAt(index + 1);
      index += 1;
    } else if (char === ',' || char === '+') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);

  const attributes: DnAttribute[] = [];
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    attributes.push({
      type: part.slice(0, separator).trim(),
      value: unescapeRfc2253(part.slice(separator + 1).trim()),
    });
  }
  return attributes;
}

/** Undoes RFC 2253 escaping: `\c` is `c`, `\XX` is the byte `XX`. */
function unescapeRfc2253(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char !== '\\') {
      out += char;
      continue;
    }
    const pair = value.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/.test(pair)) {
      out += String.fromCharCode(Number.parseInt(pair, 16));
      index += 2;
    } else {
      out += value.charAt(index + 1);
      index += 1;
    }
  }
  return out;
}

/** A DN's attributes as a sorted, comparable key: type case-insensitive, value verbatim. */
function dnKey(attributes: readonly DnAttribute[]): string {
  return attributes
    .map((attribute) => `${attribute.type.toLowerCase()}=${attribute.value}`)
    .sort()
    .join(',');
}

/** Whether `issuerName` names the same DN as `attributes`, whatever rendering it arrived in. */
function sameDn(issuerName: string, attributes: readonly forge.pki.CertificateField[]): boolean {
  const rendered = renderDnRfc2253(attributes);
  // Fast path: the common case is a peer that renders the DN exactly as this build does.
  return rendered === issuerName || dnKey(parseRfc2253(rendered)) === dnKey(parseRfc2253(issuerName));
}

/**
 * The certificate a `ds:KeyInfo` names. Every X.509 token profile form is understood: the ones
 * that *carry* the certificate (a `wsse:Reference` to a `BinarySecurityToken`, an `X509v3`
 * `KeyIdentifier`, an inline `ds:X509Certificate`) yield it directly; the ones that merely
 * *name* it (`IssuerSerial`, `SubjectKeyIdentifier`, `ThumbprintSHA1`) are looked up among
 * `trusted`, which is why an untrusted signer using one of them cannot be resolved at all.
 */
function certificateFromKeyInfo(
  ids: ReadonlyMap<string, Element[]>,
  keyInfo: Element | undefined,
  trusted: readonly TrustedCertificate[],
): forge.pki.Certificate | undefined {
  if (keyInfo === undefined) {
    return undefined;
  }
  const reference = findElement(keyInfo, NS.WSSE, 'Reference');
  if (reference !== undefined) {
    const uri = reference.getAttribute('URI') ?? '';
    const token = uri.startsWith('#') ? uniqueById(ids, uri.slice(1)) : undefined;
    const value = textOf(token);
    return certificateFromBase64(value) ?? certificateFromPkiPath(value);
  }
  const identifier = findElement(keyInfo, NS.WSSE, 'KeyIdentifier');
  if (identifier !== undefined) {
    const valueType = identifier.getAttribute('ValueType') ?? '';
    const value = textOf(identifier);
    if (valueType === WSS_TOKEN_TYPES.THUMBPRINT_SHA1) {
      return lookup(trusted, (pem) => thumbprintSha1Base64(pem) === value);
    }
    if (valueType === WSS_TOKEN_TYPES.X509_SUBJECT_KEY_IDENTIFIER) {
      return lookup(trusted, (pem) => subjectKeyIdentifierBase64(pem) === value);
    }
    return certificateFromBase64(value) ?? certificateFromPkiPath(value);
  }
  const issuerSerial = findElement(keyInfo, NS.DS, 'X509IssuerSerial');
  if (issuerSerial !== undefined) {
    const issuer = (childElement(issuerSerial, NS.DS, 'X509IssuerName')?.textContent ?? '').trim();
    const serial = (childElement(issuerSerial, NS.DS, 'X509SerialNumber')?.textContent ?? '').trim();
    return trusted.find(
      (candidate) =>
        sameDn(issuer, candidate.cert.issuer.attributes) &&
        BigInt(`0x${candidate.cert.serialNumber}`).toString(10) === serial,
    )?.cert;
  }
  const inline = findElement(keyInfo, NS.DS, 'X509Certificate');
  return inline === undefined ? undefined : certificateFromBase64(textOf(inline));
}

/** The first trusted certificate whose PEM satisfies `matches`; a form it cannot compute never matches. */
function lookup(
  trusted: readonly TrustedCertificate[],
  matches: (certPem: string) => boolean,
): forge.pki.Certificate | undefined {
  return trusted.find((candidate) => {
    try {
      return matches(candidate.pem);
    } catch {
      return false;
    }
  })?.cert;
}

/**
 * Whether `certificate` is trusted: byte-identical to a truststore certificate, or — with
 * `verifyChain` — issued (transitively) by one of them, with every certificate in the path
 * valid at `at`.
 */
function isTrusted(
  certificate: forge.pki.Certificate,
  trusted: readonly TrustedCertificate[],
  verifyChain: boolean,
  at: Date,
): boolean {
  if (trusted.length === 0) {
    return false;
  }
  const der = certificateBase64(forge.pki.certificateToPem(certificate));
  if (trusted.some((candidate) => candidate.der === der)) {
    // Pinned, but an expired certificate is not a trusted one: the equality path has to judge
    // validity against the injected clock exactly as the chain path does.
    return (
      certificate.validity.notBefore.getTime() <= at.getTime() &&
      at.getTime() <= certificate.validity.notAfter.getTime()
    );
  }
  if (!verifyChain) {
    return false;
  }
  try {
    const caStore = forge.pki.createCaStore(trusted.map((candidate) => candidate.cert));
    // `validityCheckDate` is what makes the injected clock reach forge; without it the chain
    // would be judged against the wall clock and a frozen-clock test could not exist.
    return forge.pki.verifyCertificateChain(caStore, [certificate], { validityCheckDate: at });
  } catch {
    return false;
  }
}

/**
 * `xml` — this document, serialized — with every `ds:Signature` but `keep` removed, so each is
 * verified on its own and `verifySignature`'s "first signature in the document" is this one.
 *
 * Removal is by *node identity* on the single parsed document, and every removed node is put
 * back exactly where it was before returning. Re-parsing and removing by positional index (as
 * this once did) lets a `ds:Signature` planted anywhere earlier in the document shift which
 * signature is verified — precisely the signature-wrapping trick this code exists to expose.
 */
function isolateSignature(doc: ReturnType<typeof parseXml>, signatures: readonly Element[], keep: Element): string {
  const removed = signatures
    .filter((signature) => signature !== keep)
    .map((signature) => ({ node: signature, parent: signature.parentNode, next: signature.nextSibling }));
  for (const entry of removed) {
    entry.parent?.removeChild(entry.node);
  }
  try {
    return serializeXml(doc);
  } finally {
    for (const entry of [...removed].reverse()) {
      entry.parent?.insertBefore(entry.node, entry.next);
    }
  }
}

/** The `URI`s of a `ds:Signature`'s references, without their leading `#`. */
function referenceIds(signature: Element): string[] {
  const signedInfo = childElement(signature, NS.DS, 'SignedInfo');
  if (signedInfo === undefined) {
    return [];
  }
  return findAll(signedInfo, NS.DS, 'Reference')
    .map((reference) => reference.getAttribute('URI') ?? '')
    .filter((uri) => uri.startsWith('#'))
    .map((uri) => uri.slice(1));
}

/** The envelope's `soap:Body`, in either SOAP version, or `undefined` for a non-SOAP document. */
function bodyElement(root: Element): Element | undefined {
  return findElement(root, NS.SOAP11_ENV, 'Body') ?? findElement(root, NS.SOAP12_ENV, 'Body');
}

/** Parses `wsu:Created`/`wsu:Expires`, returning `undefined` for anything not a date. */
function parseInstant(value: string | undefined): Date | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Judges the `wsu:Timestamp` under `security`, or `undefined` when there is none. */
function readTimestamp(security: Element, options: VerifyIncomingOptions): IncomingTimestampResult | undefined {
  const timestamp = findElement(security, NS.WSU, 'Timestamp');
  if (timestamp === undefined) {
    return undefined;
  }
  const createdText = childElement(timestamp, NS.WSU, 'Created')?.textContent ?? '';
  const expiresElement = childElement(timestamp, NS.WSU, 'Expires');
  const expiresText = expiresElement?.textContent ?? undefined;
  const created = parseInstant(createdText);
  const expires = parseInstant(expiresText);
  const base = {
    created: createdText.trim(),
    ...(expiresText !== undefined ? { expires: expiresText.trim() } : {}),
  };
  if (created === undefined) {
    return { ...base, fresh: false, error: 'The timestamp has no readable wsu:Created.' };
  }
  const skewMs = options.skewSeconds * 1000;
  const now = options.clock().getTime();
  if (now + skewMs < created.getTime()) {
    return { ...base, fresh: false, error: 'The message was created in the future.' };
  }
  if (expires !== undefined) {
    return now - skewMs > expires.getTime()
      ? { ...base, fresh: false, error: 'The message expired.' }
      : { ...base, fresh: true };
  }
  // No `Expires`: the skew window is all there is to judge against, so a `Created` older than
  // it is stale rather than merely unbounded.
  return now - skewMs > created.getTime()
    ? { ...base, fresh: false, error: 'The message is older than the tolerated clock skew.' }
    : { ...base, fresh: true };
}

/**
 * Verifies every `ds:Signature` in `xml`'s `wsse:Security` headers and reads its
 * `wsu:Timestamp`.
 *
 * Never throws: an unparsable, unsigned or non-SOAP message simply produces no signatures and
 * no timestamp, which is what "this response had no WS-Security" has to look like.
 *
 * @param xml the (already decrypted) response envelope
 * @param options the truststore, the clock, the tolerated skew and whether to follow chains
 * @returns one result per signature, plus the timestamp when the message carries one
 */
export function verifyIncoming(xml: string, options: VerifyIncomingOptions): VerifyIncomingResult {
  let doc: ReturnType<typeof parseXml> | undefined;
  let root: Element | undefined;
  try {
    doc = parseXml(xml, { location: 'envelope' });
    root = doc.documentElement ?? undefined;
  } catch {
    return { signatures: [] };
  }
  if (doc === undefined || root === undefined) {
    return { signatures: [] };
  }
  const document = doc;
  const securities = findAll(root, NS.WSSE, 'Security');
  const securitySignatures = new Set(securities.flatMap((security) => findAll(security, NS.DS, 'Signature')));
  // Document order, and every `ds:Signature` — including one planted outside a `wsse:Security`
  // header, which is reported as a failure rather than quietly ignored, because a wrapping
  // payload the user cannot see is worse than one that reads as broken.
  const signatures = findAll(root, NS.DS, 'Signature');
  const trusted = truststoreCertificates(options.truststore);
  const ids = idIndex(root);
  const body = bodyElement(root);
  const at = options.clock();

  const results: IncomingSignatureResult[] = signatures.map((signature) => {
    const empty = { references: [], referenceNames: [], coversBody: false, trusted: false } as const;
    if (!securitySignatures.has(signature)) {
      return { ...empty, ok: false, error: 'A ds:Signature outside the wsse:Security header is not accepted.' };
    }
    const referenced = referenceIds(signature);
    const duplicated = referenced.filter((id) => (ids.get(id)?.length ?? 0) > 1);
    if (duplicated.length > 0) {
      return {
        ...empty,
        ok: false,
        references: referenced,
        error: `duplicate-id: more than one element carries the referenced id "${duplicated[0] ?? ''}".`,
      };
    }
    const certificate = certificateFromKeyInfo(ids, childElement(signature, NS.DS, 'KeyInfo'), trusted);
    if (certificate === undefined) {
      return {
        ...empty,
        ok: false,
        error: 'The signing certificate could not be resolved from the message or the truststore.',
      };
    }
    const certPem = forge.pki.certificateToPem(certificate);
    const result = verifySignature(isolateSignature(document, signatures, signature), { certPem });
    const covered = result.references.map((id) => uniqueById(ids, id));
    return {
      ok: result.ok,
      references: result.references,
      referenceNames: covered.map((element, index) => element?.localName ?? result.references[index] ?? ''),
      coversBody: result.ok && body !== undefined && covered.includes(body),
      signerSubject: renderDn(certificate.subject.attributes),
      trusted: isTrusted(certificate, trusted, options.verifyChain, at),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  });

  const timestamp = securities.map((security) => readTimestamp(security, options)).find((found) => found !== undefined);
  return { signatures: results, ...(timestamp !== undefined ? { timestamp } : {}) };
}
