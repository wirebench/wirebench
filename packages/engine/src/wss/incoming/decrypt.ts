/**
 * Decryption of an *incoming* message: the thin layer between a resolved keystore alias and
 * Task 39's {@link decryptEnvelope}.
 *
 * The only behaviour it adds is the no-op: a response that carries neither an
 * `xenc:EncryptedKey` nor an `xenc:EncryptedData` is not an error — it is simply a response
 * that was not encrypted — so the caller gets the document back unchanged rather than a
 * `wss-decrypt-failed` it would have to special-case.
 */

import { NS } from '../../xml/namespaces.js';
import { decryptEnvelope } from '../outgoing/encryption.js';
import type { Keystore, KeystoreAlias } from '../keystore/model.js';

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
 * Whether `xml` looks encrypted at all. A string test rather than a parse: this runs on every
 * response, including the many that are not XML, and a parse failure here would be noise.
 */
function looksEncrypted(xml: string): boolean {
  return xml.includes(NS.XENC) && (xml.includes('EncryptedKey') || xml.includes('EncryptedData'));
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
