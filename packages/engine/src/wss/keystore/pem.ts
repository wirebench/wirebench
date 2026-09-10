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
import { buildChain, commonNameOf, describeCertificate, keyPemMatchesCertificate } from './certificate.js';
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
 * An encrypted key block whose algorithm this reader cannot open. Reported as `keystore-invalid`
 * rather than `keystore-bad-password` so the user is not sent round the "retype the password"
 * loop for a key that no password will ever unlock here.
 */
function unsupportedEncryptedKey(type: string, cause?: unknown): WssError {
  return new WssError(
    'keystore-invalid',
    `Encrypted "${type}" blocks are not supported: only encrypted RSA keys can be opened. ` +
      'Convert the key to an unencrypted PEM, or use a PKCS#12 keystore.',
    { details: { blockType: type }, ...(cause === undefined ? {} : { cause }) },
  );
}

/**
 * A decrypted PKCS#8 `ENCRYPTED PRIVATE KEY` block, as unencrypted PKCS#8 PEM.
 *
 * The two failure modes are told apart deliberately: the decryption itself failing is a wrong
 * password, while decrypting cleanly and then not parsing as RSA is an unsupported key type.
 */
function decryptPkcs8(pem: string, password: string): string {
  let info: forge.asn1.Asn1 | null;
  try {
    info = forge.pki.decryptPrivateKeyInfo(forge.pki.encryptedPrivateKeyFromPem(pem), password);
  } catch (error) {
    throw badPassword(error);
  }
  if (info === null) {
    throw badPassword();
  }
  try {
    forge.pki.privateKeyFromAsn1(info);
  } catch (error) {
    throw unsupportedEncryptedKey('ENCRYPTED PRIVATE KEY', error);
  }
  return forge.pki.privateKeyInfoToPem(info);
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
  if (message.type === 'ENCRYPTED PRIVATE KEY') {
    return decryptPkcs8(pem, password);
  }
  // A legacy `Proc-Type: 4,ENCRYPTED` block names its key type in the header, so an EC or DSA
  // one can be refused before a passphrase is even tried.
  if (message.type !== 'RSA PRIVATE KEY') {
    throw unsupportedEncryptedKey(message.type);
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

/**
 * Reads a PEM bundle.
 *
 * @param bytes the raw bundle content (UTF-8 text)
 * @param password the passphrase of an encrypted key block, if there is one
 * @returns a keystore with exactly one alias: the leaf, with every other certificate as chain
 * @throws WssError `keystore-invalid` when the bytes hold no certificate or the key block is
 * encrypted with an unsupported (non-RSA) algorithm, `keystore-bad-password` when an encrypted
 * key block cannot be decrypted with `password`
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
    (keyPem === undefined ? undefined : certificates.find((cert) => keyPemMatchesCertificate(keyPem, cert))) ??
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
