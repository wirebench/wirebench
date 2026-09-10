/**
 * Test-time certificate authority and leaf certificates, generated in-process with
 * `node-forge` so the repository carries no key material and nothing ever expires
 * in CI. Everything is memoised per test process: RSA-2048 key generation is the
 * expensive part, and one CA plus one server/client pair covers the whole suite.
 *
 * Test-only. Never import this from production code.
 */

import forge from 'node-forge';

/** A PEM certificate/private-key pair. */
export interface TestCertificate {
  readonly certPem: string;
  readonly keyPem: string;
}

/** Certificates are valid from an hour ago (clock skew) until this far ahead. */
const VALIDITY_MS = 24 * 60 * 60 * 1000;
const SKEW_MS = 60 * 60 * 1000;

/** Distinguished-name attribute shape forge's `setSubject`/`setIssuer` take. */
type Attribute = { readonly name?: string; readonly shortName?: string; readonly value: string };

function attributes(commonName: string): Attribute[] {
  return [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'Wirebench Tests' },
    { name: 'countryName', value: 'ZZ' },
  ];
}

/** A serial number forge accepts: a positive hex integer (a leading `00` keeps it unsigned). */
function serial(): string {
  return `00${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
}

function newCertificate(publicKey: forge.pki.PublicKey, commonName: string): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - SKEW_MS);
  cert.validity.notAfter = new Date(Date.now() + VALIDITY_MS);
  cert.setSubject(attributes(commonName));
  return cert;
}

let cachedCa: (TestCertificate & { readonly commonName: string }) | undefined;

/**
 * The self-signed CA every other certificate here is issued by. Memoised: the
 * first call pays for one RSA-2048 key pair, later calls are free.
 *
 * @returns the CA's PEM certificate and private key
 */
export function generateTestCa(): TestCertificate & { readonly commonName: string } {
  if (cachedCa !== undefined) return cachedCa;
  const commonName = 'Wirebench Test CA';
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = newCertificate(keys.publicKey, commonName);
  cert.setIssuer(attributes(commonName));
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  cachedCa = {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    commonName,
  };
  return cachedCa;
}

/** Turns SAN strings into forge's altNames entries: an IP literal becomes type 7, anything else type 2 (DNS). */
function altNames(sans: readonly string[]): { type: number; value?: string; ip?: string }[] {
  return sans.map((san) =>
    /^[\d.]+$/.test(san) || san.includes(':') ? { type: 7, ip: san } : { type: 2, value: san },
  );
}

/** Signs `cert` with the memoised CA's key and returns the PEM pair. */
function issue(ca: TestCertificate, cert: forge.pki.Certificate, privateKey: forge.pki.PrivateKey): TestCertificate {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  cert.setIssuer(caCert.subject.attributes);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(privateKey) };
}

const cachedServerCerts = new Map<string, TestCertificate>();

/**
 * A server certificate issued by `ca`, with `serverAuth` extended key usage and
 * the given SANs (default `localhost` + `127.0.0.1`). Memoised per
 * commonName/SAN combination.
 *
 * @param ca the issuing authority, from {@link generateTestCa}
 * @param options the leaf's common name and subject alternative names
 * @returns the server's PEM certificate and private key
 */
export function generateServerCert(
  ca: TestCertificate,
  options?: { readonly commonName?: string; readonly sans?: readonly string[] },
): TestCertificate {
  const commonName = options?.commonName ?? 'localhost';
  const sans = options?.sans ?? ['localhost', '127.0.0.1'];
  const cacheKey = `${commonName}|${sans.join(',')}`;
  const cached = cachedServerCerts.get(cacheKey);
  if (cached !== undefined) return cached;

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = newCertificate(keys.publicKey, commonName);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: altNames(sans) },
  ]);
  const issued = issue(ca, cert, keys.privateKey);
  cachedServerCerts.set(cacheKey, issued);
  return issued;
}

let cachedClientCert: TestCertificate | undefined;

/**
 * A client certificate issued by `ca`, with `clientAuth` extended key usage —
 * what a `requestCert: true` server verifies against. Memoised per test process.
 *
 * @param ca the issuing authority, from {@link generateTestCa}
 * @returns the client's PEM certificate and private key
 */
export function generateClientCert(ca: TestCertificate): TestCertificate {
  if (cachedClientCert !== undefined) return cachedClientCert;
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = newCertificate(keys.publicKey, 'wirebench-client');
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', clientAuth: true },
  ]);
  cachedClientCert = issue(ca, cert, keys.privateKey);
  return cachedClientCert;
}

/**
 * A PKCS#12 holding `leaf`'s key and certificate with `ca` attached as its chain — the file a
 * "client keystore" test (or e2e spec) needs, built in-process so no binary fixture is checked
 * in. Not memoised: the password and friendly name are the point of varying it.
 *
 * @param ca the issuing authority, from {@link generateTestCa}
 * @param leaf the identity to store, from {@link generateClientCert}
 * @param options the keystore password and the entry's friendly name (default `client`)
 * @returns the DER bytes of the `.p12` file
 */
export function generateClientPkcs12(
  ca: TestCertificate,
  leaf: TestCertificate,
  options: { readonly password: string; readonly friendlyName?: string },
): Uint8Array {
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    forge.pki.privateKeyFromPem(leaf.keyPem),
    [forge.pki.certificateFromPem(leaf.certPem), forge.pki.certificateFromPem(ca.certPem)],
    options.password,
    { friendlyName: options.friendlyName ?? 'client', algorithm: '3des' },
  );
  return Uint8Array.from(Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'));
}
