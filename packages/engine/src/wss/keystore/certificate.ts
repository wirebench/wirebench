/**
 * The certificate metadata both keystore readers need — subject/issuer rendering, validity,
 * serial and fingerprint — kept in one place so a PKCS#12 alias and a PEM alias describe the
 * same certificate identically.
 */

import forge from 'node-forge';
import type { KeystoreAlias } from './model.js';

/** Renders a forge distinguished name as `CN=…, O=…`, in the certificate's own attribute order. */
export function renderDn(attributes: readonly forge.pki.CertificateField[]): string {
  return attributes
    .map((attribute) => `${attribute.shortName ?? attribute.name ?? attribute.type ?? '?'}=${String(attribute.value)}`)
    .join(', ');
}

/** SHA-256 of the DER encoding, as upper-case hex in colon-separated pairs (OpenSSL's rendering). */
export function fingerprintSha256(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const hex = forge.md.sha256.create().update(der).digest().toHex().toUpperCase();
  return (hex.match(/.{2}/g) ?? []).join(':');
}

/** The common name of a certificate's subject, or `undefined` when it has none. */
export function commonNameOf(cert: forge.pki.Certificate): string | undefined {
  const field = cert.subject.getField('CN') as { value?: unknown } | null;
  const value = field?.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A DER serial number as upper-case hex, with the leading unsigned-padding byte dropped. */
function serialOf(cert: forge.pki.Certificate): string {
  const raw = cert.serialNumber.toUpperCase();
  return raw.length > 2 && raw.startsWith('00') ? raw.slice(2) : raw;
}

/** Everything but the alias name and the key: the certificate half of a {@link KeystoreAlias}. */
export function describeCertificate(
  cert: forge.pki.Certificate,
): Omit<KeystoreAlias, 'alias' | 'keyPem' | 'chainPem' | 'hasPrivateKey'> {
  return {
    certPem: forge.pki.certificateToPem(cert),
    subject: renderDn(cert.subject.attributes),
    issuer: renderDn(cert.issuer.attributes),
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    serial: serialOf(cert),
    fingerprintSha256: fingerprintSha256(cert),
  };
}

/**
 * The issuer chain of `leaf`, nearest issuer first, walked through `pool`. Stops at a
 * self-signed certificate and never visits the same certificate twice, so a cross-signed pair
 * cannot loop. Certificates it consumed are added to `used`.
 */
export function buildChain(
  leaf: forge.pki.Certificate,
  pool: readonly forge.pki.Certificate[],
  used: Set<forge.pki.Certificate>,
): forge.pki.Certificate[] {
  const chain: forge.pki.Certificate[] = [];
  let current = leaf;
  for (;;) {
    if (current.isIssuer(current)) {
      return chain;
    }
    const issuer = pool.find(
      (candidate) => candidate !== current && !chain.includes(candidate) && current.isIssuer(candidate),
    );
    if (issuer === undefined) {
      return chain;
    }
    chain.push(issuer);
    used.add(issuer);
    current = issuer;
  }
}
