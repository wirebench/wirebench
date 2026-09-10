/**
 * PEM bundle reading: one or more `CERTIFICATE` blocks plus at most one private-key block, in
 * any order — the shape `cat client.crt client.key ca.crt > client.pem` produces.
 *
 * Unencrypted key blocks are passed through **verbatim** rather than re-encoded: Node's `tls`
 * accepts PKCS#1, PKCS#8 and SEC1 (EC) keys as they stand, and re-encoding them through forge
 * would silently drop the key types forge cannot model. Only an encrypted block is decrypted,
 * because a passphrase-protected key is exactly what the keystore password is for.
 */

import forge from 'node-forge';
import { WssError } from '../../errors.js';
import { buildChain, commonNameOf, describeCertificate } from './certificate.js';
import type { Keystore, KeystoreAlias } from './model.js';

/** The block types this reader treats as a private key. */
const KEY_TYPES = new Set(['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']);

/** forge's decoded PEM message, narrowed to what this module reads. */
interface PemMessage {
  readonly type: string;
  readonly procType?: { readonly type?: string } | null;
}

function invalid(message: string, cause?: unknown): WssError {
  return new WssError('keystore-invalid', message, cause === undefined ? undefined : { cause });
}

function badPassword(cause?: unknown): WssError {
  return new WssError('keystore-bad-password', 'The keystore password is incorrect or missing.', {
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Re-renders one decoded message back to PEM text, so each block can be handled on its own. */
function toPem(message: PemMessage): string {
  return forge.pem.encode(message as unknown as forge.pem.ObjectPEM);
}

/** True when the block cannot be used without a passphrase. */
function isEncrypted(message: PemMessage): boolean {
  return message.type === 'ENCRYPTED PRIVATE KEY' || (message.procType?.type ?? '') === 'ENCRYPTED';
}

/**
 * The usable key PEM for `message`: the block verbatim when it is not encrypted, the decrypted
 * PKCS#8 rendering when it is.
 */
function keyPemOf(message: PemMessage, password: string | undefined): string {
  const pem = toPem(message);
  if (!isEncrypted(message)) {
    return pem;
  }
  if (password === undefined || password.length === 0) {
    throw badPassword();
  }
  let key: forge.pki.PrivateKey | null;
  try {
    key = forge.pki.decryptRsaPrivateKey(pem, password);
  } catch (error) {
    throw badPassword(error);
  }
  if (key === null) {
    throw badPassword();
  }
  return forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key)));
}

/** Whether `keyPem` is the private half of `cert`'s public key; `false` when forge cannot tell. */
function matchesCertificate(keyPem: string, cert: forge.pki.Certificate): boolean {
  try {
    const key = forge.pki.privateKeyFromPem(keyPem) as { n?: { toString(radix: number): string } };
    const publicKey = cert.publicKey as { n?: { toString(radix: number): string } };
    if (key.n === undefined || publicKey.n === undefined) {
      return false;
    }
    return key.n.toString(16) === publicKey.n.toString(16);
  } catch {
    return false;
  }
}

/**
 * Reads a PEM bundle.
 *
 * @param bytes the raw bundle content (UTF-8 text)
 * @param password the passphrase of an encrypted key block, if there is one
 * @returns a keystore with exactly one alias: the leaf, with every other certificate as chain
 * @throws WssError `keystore-invalid` when the bytes hold no certificate, `keystore-bad-password`
 * when an encrypted key block cannot be decrypted with `password`
 */
export function loadPem(bytes: Uint8Array, password?: string): Keystore {
  const text = Buffer.from(bytes).toString('utf8');
  let messages: PemMessage[];
  try {
    messages = forge.pem.decode(text);
  } catch (error) {
    throw invalid('The file is not a readable PEM bundle.', error);
  }
  const certificates = messages
    .filter((message) => message.type === 'CERTIFICATE')
    .map((message) => forge.pki.certificateFromPem(toPem(message)));
  if (certificates.length === 0) {
    throw invalid('The PEM bundle holds no certificate.');
  }
  const keyMessage = messages.find((message) => KEY_TYPES.has(message.type));
  const keyPem = keyMessage === undefined ? undefined : keyPemOf(keyMessage, password);

  const leaf =
    (keyPem === undefined ? undefined : certificates.find((cert) => matchesCertificate(keyPem, cert))) ??
    certificates[0];
  /* c8 ignore next 3 -- `certificates` is non-empty above, so `leaf` is always defined. */
  if (leaf === undefined) {
    throw invalid('The PEM bundle holds no certificate.');
  }
  const used = new Set<forge.pki.Certificate>([leaf]);
  const chain = buildChain(leaf, certificates, used);
  const alias: KeystoreAlias = {
    alias: commonNameOf(leaf) ?? 'key-0',
    ...describeCertificate(leaf),
    ...(keyPem === undefined ? {} : { keyPem }),
    chainPem: chain.map((cert) => forge.pki.certificateToPem(cert)),
    hasPrivateKey: keyPem !== undefined,
  };
  return { type: 'pem', aliases: [alias] };
}
