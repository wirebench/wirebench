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

/** Characters RFC 2253/4514 requires escaping wherever they appear in an attribute value. */
const RFC2253_ESCAPED_CHARS = new Set([',', '+', '"', '\\', '<', '>', ';', '=']);

/**
 * Escapes one RFC 2253/4514 attribute value: the always-escaped characters above, a leading
 * `#` or space, a trailing space, and control characters as `\` followed by two hex digits.
 */
function escapeRfc2253Value(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const code = value.charCodeAt(index);
    if (RFC2253_ESCAPED_CHARS.has(char)) {
      out += `\\${char}`;
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\${code.toString(16).padStart(2, '0')}`;
    } else if ((index === 0 && (char === '#' || char === ' ')) || (index === value.length - 1 && char === ' ')) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Renders a forge distinguished name in RFC 2253/4514 form: most specific attribute first (the
 * reverse of the certificate's own, least-specific-first order), `,`-separated with no space,
 * and every value escaped per {@link escapeRfc2253Value}.
 *
 * Used only where the DN feeds into a signature (`X509IssuerName` and friends) — the UI keeps
 * using {@link renderDn}, which is easier to read and never needs to round-trip.
 */
export function renderDnRfc2253(attributes: readonly forge.pki.CertificateField[]): string {
  return [...attributes]
    .reverse()
    .map((attribute) => {
      const name = attribute.shortName ?? attribute.name ?? attribute.type ?? '?';
      return `${name}=${escapeRfc2253Value(String(attribute.value))}`;
    })
    .join(',');
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

/**
 * Whether `key` is the private half of `cert`'s public key.
 *
 * Compares the RSA modulus, which is the only public-key field node-forge models for every key
 * type it can parse. `false` whenever the comparison cannot be made at all (a non-RSA key, an
 * unparsable PEM), so a caller pairing a key with a certificate never pairs them *by accident*:
 * "cannot prove they match" and "they do not match" must both mean no.
 *
 * @param key the private key to test
 * @param cert the certificate whose public key it should belong to
 * @returns `true` only when both moduli are present and equal
 */
export function keyMatchesCertificate(key: forge.pki.PrivateKey, cert: forge.pki.Certificate): boolean {
  const modulus = (key as { n?: { toString(radix: number): string } }).n;
  const certModulus = (cert.publicKey as { n?: { toString(radix: number): string } }).n;
  if (modulus === undefined || certModulus === undefined) {
    return false;
  }
  return modulus.toString(16) === certModulus.toString(16);
}

/** {@link keyMatchesCertificate} for a key that is still PEM text; `false` when it will not parse. */
export function keyPemMatchesCertificate(keyPem: string, cert: forge.pki.Certificate): boolean {
  try {
    return keyMatchesCertificate(forge.pki.privateKeyFromPem(keyPem), cert);
  } catch {
    return false;
  }
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
