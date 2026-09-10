/**
 * PKCS#12 (`.p12`/`.pfx`) reading, via node-forge.
 *
 * A PKCS#12 file is a bag of bags: shrouded key bags, certificate bags, and attributes
 * (`friendlyName`, `localKeyId`) that tie a key to its certificate. This module flattens that
 * into the alias list the rest of Wirebench works with, re-exporting every private key as an
 * unencrypted PKCS#8 PEM **in memory only** — nothing here writes to disk, and the caller is
 * expected to keep the result out of the renderer.
 */

import forge from 'node-forge';
import { WssError } from '../../errors.js';
import { buildChain, commonNameOf, describeCertificate, keyMatchesCertificate } from './certificate.js';
import type { Keystore, KeystoreAlias } from './model.js';

/** forge's bag shape, narrowed to the fields this module reads. */
interface Bag {
  readonly cert?: forge.pki.Certificate | null;
  readonly key?: forge.pki.PrivateKey | null;
  readonly attributes?: Readonly<Record<string, readonly string[] | undefined>>;
}

function invalid(cause: unknown): WssError {
  return new WssError('keystore-invalid', 'The file is not a readable PKCS#12 keystore.', { cause });
}

/**
 * Wrong-password failures are the common case and must be distinguishable from a corrupt file.
 *
 * Matched narrowly, on forge's MAC/password wording only: a broader pattern (anything mentioning
 * "decrypt", say) swallows genuinely malformed files and reports them as a bad password, which
 * sends the user round a retype loop no password can end.
 */
function looksLikeBadPassword(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /mac could not be verified|invalid password|wrong password|password is (?:invalid|incorrect)/i.test(message);
}

/** A key as an unencrypted PKCS#8 PEM — what Node's `tls` accepts without a passphrase. */
function toPkcs8Pem(key: forge.pki.PrivateKey): string {
  return forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key)));
}

function attribute(bag: Bag, name: string): string | undefined {
  const value = bag.attributes?.[name]?.[0];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Every bag of one type, flattened out of forge's `{ [oid]: Bag[] }` result. */
function bagsOfType(p12: forge.pkcs12.Pkcs12Pfx, bagType: string): Bag[] {
  const found = p12.getBags({ bagType }) as Readonly<Record<string, Bag[] | undefined>>;
  return Object.values(found).flatMap((bags) => bags ?? []);
}

/**
 * Reads a PKCS#12 keystore.
 *
 * @param bytes the raw `.p12`/`.pfx` content
 * @param password the keystore password; an empty/absent password is tried as `''`
 * @returns the parsed keystore, one alias per key entry plus one per unused certificate
 * @throws WssError `keystore-bad-password` when the MAC does not verify, `keystore-invalid`
 * when the bytes are not a PKCS#12 file at all, or when a key it holds matches none of its
 * certificates
 */
export function loadPkcs12(bytes: Uint8Array, password?: string): Keystore {
  const binary = forge.util.createBuffer(Buffer.from(bytes).toString('binary'));
  let asn1: forge.asn1.Asn1;
  try {
    asn1 = forge.asn1.fromDer(binary);
  } catch (error) {
    throw invalid(error);
  }
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password ?? '');
  } catch (error) {
    if (looksLikeBadPassword(error)) {
      throw new WssError('keystore-bad-password', 'The keystore password is incorrect.', { cause: error });
    }
    throw invalid(error);
  }

  const certBags = bagsOfType(p12, forge.pki.oids['certBag'] ?? 'certBag');
  const keyBags = [
    ...bagsOfType(p12, forge.pki.oids['pkcs8ShroudedKeyBag'] ?? 'pkcs8ShroudedKeyBag'),
    ...bagsOfType(p12, forge.pki.oids['keyBag'] ?? 'keyBag'),
  ];
  const certificates = certBags.map((bag) => bag.cert).filter((cert): cert is forge.pki.Certificate => !!cert);
  if (certificates.length === 0) {
    throw invalid(new Error('the keystore holds no certificates'));
  }

  const used = new Set<forge.pki.Certificate>();
  const aliases: KeystoreAlias[] = [];

  keyBags.forEach((keyBag, index) => {
    const key = keyBag.key;
    if (!key) {
      return;
    }
    const localKeyId = attribute(keyBag, 'localKeyId');
    // `localKeyId` is the file's own statement of which certificate belongs to this key, so it
    // wins. Without one, the pairing is *proved* by the public key rather than guessed from bag
    // order: a `.p12` written as [ca, leaf] would otherwise hand the client's key the CA's
    // certificate and present an identity the key cannot sign for.
    const certBag =
      certBags.find((bag) => !!bag.cert && localKeyId !== undefined && attribute(bag, 'localKeyId') === localKeyId) ??
      certBags.find((bag) => !!bag.cert && !used.has(bag.cert) && keyMatchesCertificate(key, bag.cert));
    const cert = certBag?.cert;
    if (!cert) {
      throw new WssError('keystore-invalid', 'The keystore holds a private key that matches none of its certificates.');
    }
    used.add(cert);
    const chain = buildChain(cert, certificates, used);
    aliases.push({
      alias:
        attribute(keyBag, 'friendlyName') ??
        (certBag === undefined ? undefined : attribute(certBag, 'friendlyName')) ??
        commonNameOf(cert) ??
        `key-${String(index)}`,
      ...describeCertificate(cert),
      keyPem: toPkcs8Pem(key),
      chainPem: chain.map((issuer) => forge.pki.certificateToPem(issuer)),
      hasPrivateKey: true,
    });
  });

  // Whatever is left is a trust anchor the file happened to carry: still worth listing, so the
  // UI can show what the user actually imported, but never usable as a client identity.
  certBags.forEach((bag, index) => {
    const cert = bag.cert;
    if (!cert || used.has(cert)) {
      return;
    }
    used.add(cert);
    aliases.push({
      alias: attribute(bag, 'friendlyName') ?? commonNameOf(cert) ?? `cert-${String(index)}`,
      ...describeCertificate(cert),
      chainPem: [],
      hasPrivateKey: false,
    });
  });

  return { type: 'pkcs12', aliases };
}
