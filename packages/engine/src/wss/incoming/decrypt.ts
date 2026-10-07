/**
 * Decryption of an *incoming* message: the thin layer between a resolved keystore alias and
 * Task 39's {@link decryptEnvelope}.
 *
 * The only behaviour it adds is the no-op: a response that carries neither an
 * `xenc:EncryptedKey` nor an `xenc:EncryptedData` is not an error — it is simply a response
 * that was not encrypted — so the caller gets the document back unchanged rather than a
 * `wss-decrypt-failed` it would have to special-case.
 */

import forge from 'node-forge';
import type { Element } from '@xmldom/xmldom';
import { NS } from '../../xml/namespaces.js';
import { parseXml } from '../../xml/parse.js';
import { renderDn } from '../../keystore/certificate.js';
import { childElement, findElement } from '../security-header.js';
import {
  issuerDnRfc2253,
  serialNumberDecimal,
  subjectKeyIdentifierBase64,
  thumbprintSha1Base64,
  WSS_TOKEN_TYPES,
} from '../key-identifiers.js';
import { decryptEnvelope } from '../outgoing/encryption.js';
import type { Keystore, KeystoreAlias } from '../../keystore/model.js';

/** The keystore material {@link decryptIncoming} opens an `xenc:EncryptedKey` with. */
export interface ResolvedDecryptionKey {
  readonly keystore: Keystore;
  /** The alias whose private key unwraps the symmetric key. */
  readonly alias: KeystoreAlias;
  /** Passphrase for an encrypted private key PEM. Resolved by the host; never logged. */
  readonly keyPassword?: string;
}

/** The outcome of {@link decryptIncoming}. */
export interface DecryptIncomingResult {
  /** The message with every block this key could open restored; the input when there was none. */
  readonly xml: string;
  /** The plaintext of each decrypted block, in `ReferenceList` order. Empty for a no-op. */
  readonly decrypted: readonly string[];
}

/**
 * Whether `xml` really carries XML-Encryption: an `xenc:EncryptedKey` or `xenc:EncryptedData`
 * *element*, found in the DOM.
 *
 * A substring test (the previous implementation) says yes to a response that merely mentions
 * those words in its text — an error message quoting them, say — and that answer turns a plain
 * response into a `wss-decrypt-failed`. The cheap substring test stays as a pre-filter so the
 * many responses that are not XML at all are never parsed.
 */
function looksEncrypted(xml: string): boolean {
  if (!xml.includes(NS.XENC) || (!xml.includes('EncryptedKey') && !xml.includes('EncryptedData'))) {
    return false;
  }
  try {
    const root = parseXml(xml, { location: 'envelope' }).documentElement;
    if (root === null) {
      return false;
    }
    return (
      findElement(root, NS.XENC, 'EncryptedKey') !== undefined ||
      findElement(root, NS.XENC, 'EncryptedData') !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * Decrypts an incoming message with `resolved`, or returns it untouched when it carries no
 * XML-Encryption at all.
 *
 * @param xml the response envelope
 * @param resolved the keystore alias (and passphrase) to decrypt with
 * @returns the restored envelope and the plaintext of each decrypted block
 * @throws WssError `wss-decrypt-failed`, `wss-algorithm-unsupported`, `wss-decryption-key-missing`
 */
export function decryptIncoming(xml: string, resolved: ResolvedDecryptionKey): DecryptIncomingResult {
  if (!looksEncrypted(xml)) {
    return { xml, decrypted: [] };
  }
  return decryptEnvelope(xml, {
    keystore: resolved.keystore,
    alias: resolved.alias,
    ...(resolved.keyPassword !== undefined ? { keyPassword: resolved.keyPassword } : {}),
  });
}

/** How a `ds:KeyInfo` names a certificate, and what the alias's certificate gives in the same form. */
interface NamedCertificate {
  readonly form: string;
  readonly wanted: string;
  readonly have: string;
}

/** The subject DN of a base64 DER certificate, or `undefined` when the bytes are not one. */
function subjectOfBase64(value: string): string | undefined {
  try {
    const der = forge.util.createBuffer(Buffer.from(value, 'base64').toString('binary'));
    return renderDn(forge.pki.certificateFromAsn1(forge.asn1.fromDer(der)).subject.attributes);
  } catch {
    return undefined;
  }
}

/** The subject DN of a PEM certificate. */
function subjectOfPem(certPem: string): string {
  return renderDn(forge.pki.certificateFromPem(certPem).subject.attributes);
}

/** The text of `element` with whitespace removed, so wrapped base64 compares. */
function compact(element: Element | undefined): string {
  return element === undefined ? '' : (element.textContent ?? '').replace(/\s+/g, '');
}

/** How `keyInfo` names its certificate, beside the same form computed for `certPem`. */
function namedBy(root: Element, keyInfo: Element, certPem: string): NamedCertificate | undefined {
  const identifier = findElement(keyInfo, NS.WSSE, 'KeyIdentifier');
  if (identifier !== undefined) {
    const valueType = identifier.getAttribute('ValueType') ?? '';
    const value = compact(identifier);
    if (valueType === WSS_TOKEN_TYPES.THUMBPRINT_SHA1) {
      return { form: 'ThumbprintSHA1', wanted: value, have: thumbprintSha1Base64(certPem) };
    }
    if (valueType === WSS_TOKEN_TYPES.X509_SUBJECT_KEY_IDENTIFIER) {
      return { form: 'SubjectKeyIdentifier', wanted: value, have: subjectKeyIdentifierBase64(certPem) };
    }
    const subject = subjectOfBase64(value);
    return subject === undefined ? undefined : { form: 'subject', wanted: subject, have: subjectOfPem(certPem) };
  }
  const issuerSerial = findElement(keyInfo, NS.DS, 'X509IssuerSerial');
  if (issuerSerial !== undefined) {
    const issuer = (childElement(issuerSerial, NS.DS, 'X509IssuerName')?.textContent ?? '').trim();
    const serial = (childElement(issuerSerial, NS.DS, 'X509SerialNumber')?.textContent ?? '').trim();
    return {
      form: 'issuer and serial',
      wanted: `"${issuer}" ${serial}`,
      have: `"${issuerDnRfc2253(certPem)}" ${serialNumberDecimal(certPem)}`,
    };
  }
  const reference = findElement(keyInfo, NS.WSSE, 'Reference');
  if (reference !== undefined) {
    const uri = reference.getAttribute('URI') ?? '';
    const id = uri.startsWith('#') ? uri.slice(1) : '';
    const token = id === '' ? undefined : findById(root, id);
    const subject = subjectOfBase64(compact(token));
    return subject === undefined ? undefined : { form: 'subject', wanted: subject, have: subjectOfPem(certPem) };
  }
  return undefined;
}

/** The first element under `root` whose `Id` attribute (any namespace) is `id`. */
function findById(root: Element, id: string): Element | undefined {
  for (let position = 0; position < root.attributes.length; position += 1) {
    const attribute = root.attributes.item(position);
    if (attribute?.localName === 'Id' && attribute.value === id) {
      return root;
    }
  }
  for (let child = root.firstChild; child !== null; child = child.nextSibling) {
    if (child.nodeType === 1) {
      const found = findById(child as Element, id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Why an encrypted message did not open with the configured alias, from the message's side: the
 * certificate its first `xenc:EncryptedKey` names, beside what the alias has in the same form.
 *
 * Never throws; `undefined` when the message names its certificate in no form this can compare.
 *
 * @param xml the encrypted response envelope
 * @param certPem the decryption alias's certificate
 * @param aliasName the decryption alias's name, as the user configured it
 * @returns a sentence such as `The message's xenc:EncryptedKey names its certificate by ThumbprintSHA1 a=; the decryption alias "server" has b=.`
 */
export function encryptedKeyMismatch(xml: string, certPem: string, aliasName: string): string | undefined {
  try {
    const root = parseXml(xml, { location: 'envelope' }).documentElement;
    const encryptedKey = root === null ? undefined : findElement(root, NS.XENC, 'EncryptedKey');
    const keyInfo = encryptedKey === undefined ? undefined : childElement(encryptedKey, NS.DS, 'KeyInfo');
    if (root === null || keyInfo === undefined) {
      return undefined;
    }
    const named = namedBy(root, keyInfo, certPem);
    // The same certificate on both sides means the key is not the problem; say nothing.
    if (named === undefined || named.wanted === named.have) {
      return undefined;
    }
    return (
      `The message's xenc:EncryptedKey names its certificate by ${named.form} ${named.wanted}; ` +
      `the decryption alias "${aliasName}" has ${named.have}.`
    );
  } catch {
    return undefined;
  }
}
