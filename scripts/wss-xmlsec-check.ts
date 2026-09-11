/**
 * Cross-checks Wirebench's WS-Security signatures against `xmlsec1`, the reference
 * implementation, so a signature this build self-verifies is not merely self-consistent.
 *
 * For every key identifier form x signature algorithm it builds a signed SOAP envelope through
 * the engine's public API (`applyOutgoingWss`), writes it to a temporary directory next to the
 * signer's certificate, and runs:
 *
 *   xmlsec1 --verify \
 *     --id-attr:Id http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd:Timestamp \
 *     --id-attr:Id http://schemas.xmlsoap.org/soap/envelope/:Body \
 *     --pubkey-cert-pem cert.pem \
 *     --enabled-key-data raw-x509-cert \
 *     <case>.xml
 *
 * `--id-attr:<attr>` tells xmlsec1 which attribute carries the id for a given element (it does
 * not know the WS-Security schema). `--pubkey-cert-pem` and `--enabled-key-data raw-x509-cert`
 * go together and both matter: `--pubkey-cert-pem` hands xmlsec1 the certificate to verify
 * against directly (so the document's own `KeyInfo`/`SecurityTokenReference` is never trusted,
 * mirroring what {@link verifySignature} does), and `--enabled-key-data raw-x509-cert` is what
 * makes xmlsec1 actually *use* that supplied certificate for every key identifier form this
 * script exercises — including the four (`IssuerSerial`, `SubjectKeyIdentifier`,
 * `X509KeyIdentifier`, `Thumbprint`) that never embed the certificate itself, so without this
 * flag xmlsec1 would have nothing to resolve the `SecurityTokenReference` against and every one
 * of those cases would fail closed rather than actually being checked. If a CI case starts
 * failing here, drop `--enabled-key-data raw-x509-cert` first (not `--pubkey-cert-pem`, which
 * is load-bearing for every case) to see whether it's this flag's key-resolution behavior at
 * fault versus a real signature/canonicalization regression. Finally one signed envelope is
 * tampered with and expected to FAIL.
 *
 * Run with `pnpm test:wss-xmlsec` (which builds the engine first). Without `xmlsec1` on
 * `PATH` the check prints a note and exits 0, unless `WIREBENCH_REQUIRE_XMLSEC=1` is set.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOutgoingWss, createWssContext } from '../packages/engine/dist/index.js';
import type {
  Keystore,
  WssKeyIdentifierType,
  WssOutgoingConfig,
  WssSignatureEntry,
} from '../packages/engine/dist/index.js';
import { generateSigningCert, generateTestCa } from '../packages/engine/test/helpers/test-certs.ts';

const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const SOAP11_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12_NS = 'http://www.w3.org/2003/05/soap-envelope';

const ENVELOPE =
  `<soapenv:Envelope xmlns:soapenv="${SOAP11_NS}">` +
  '<soapenv:Body><tns:Echo xmlns:tns="urn:wirebench"><tns:Text>hello</tns:Text></tns:Echo></soapenv:Body>' +
  '</soapenv:Envelope>';

/** A SOAP 1.2 envelope, to prove the check (and the signature it verifies) is not 1.1-only. */
const SOAP12_ENVELOPE =
  `<soapenv:Envelope xmlns:soapenv="${SOAP12_NS}">` +
  '<soapenv:Body><tns:Echo xmlns:tns="urn:wirebench"><tns:Text>hello</tns:Text></tns:Echo></soapenv:Body>' +
  '</soapenv:Envelope>';

/**
 * An envelope whose Body carries a QName only inside an attribute *value* (`xsi:type="tns:Foo"`,
 * with `tns` declared on the Envelope rather than on `Echo` itself) — exclusive c14n's
 * "visible utilization" rule never inspects attribute values, so this is exactly the case
 * Finding 1 fixed: without an `InclusiveNamespaces PrefixList` carrying `tns`, xmlsec1
 * (canonicalizing the reference independently, the way a real receiver would) cannot resolve
 * the QName and the signature fails to verify even though nothing was tampered with.
 */
const QNAME_ENVELOPE =
  `<soapenv:Envelope xmlns:soapenv="${SOAP11_NS}" xmlns:tns="urn:wirebench">` +
  '<soapenv:Body><tns:Echo xsi:type="tns:Foo" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  '<tns:Text>hello</tns:Text></tns:Echo></soapenv:Body></soapenv:Envelope>';

const KEY_IDENTIFIERS: readonly WssKeyIdentifierType[] = [
  'BinarySecurityToken',
  'IssuerSerial',
  'SubjectKeyIdentifier',
  'X509KeyIdentifier',
  'Thumbprint',
];

const ALGORITHMS = [
  { signatureAlgorithm: 'rsa-sha256', digestAlgorithm: 'sha256' },
  { signatureAlgorithm: 'rsa-sha1', digestAlgorithm: 'sha1' },
] as const;

/** True when `xmlsec1` can be executed. */
function hasXmlsec(): boolean {
  const probe = spawnSync('xmlsec1', ['--version'], { stdio: 'ignore' });
  return probe.error === undefined && probe.status === 0;
}

/** The `xmlsec1 --verify` argument list for `file`, verifying against `certPath`. */
export function xmlsecVerifyArgs(file: string, certPath: string): string[] {
  return [
    '--verify',
    '--id-attr:Id',
    `${WSU_NS}:Timestamp`,
    '--id-attr:Id',
    `${SOAP11_NS}:Body`,
    // Both envelope namespaces' Body id-attr are always declared: harmless for a SOAP 1.1 case,
    // needed for the SOAP 1.2 one below.
    '--id-attr:Id',
    `${SOAP12_NS}:Body`,
    '--pubkey-cert-pem',
    certPath,
    '--enabled-key-data',
    'raw-x509-cert',
    file,
  ];
}

/** The outgoing configuration for one case: a Timestamp followed by the signature. */
function configFor(entry: WssSignatureEntry): WssOutgoingConfig {
  return {
    id: 'xmlsec-check',
    name: 'xmlsec check',
    mustUnderstand: false,
    entries: [{ kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false }, entry],
  };
}

async function main(): Promise<void> {
  if (!hasXmlsec()) {
    const required = process.env['WIREBENCH_REQUIRE_XMLSEC'] === '1';
    console.log('xmlsec1 not found — skipping cross-check (set WIREBENCH_REQUIRE_XMLSEC=1 to fail)');
    process.exit(required ? 1 : 0);
  }

  const ca = generateTestCa();
  const signer = generateSigningCert(ca);
  const keystore: Keystore = {
    type: 'pem',
    aliases: [
      {
        alias: 'signer',
        certPem: signer.certPem,
        keyPem: signer.keyPem,
        chainPem: [ca.certPem],
        subject: 'CN=wirebench-signer',
        issuer: 'CN=Wirebench Test CA',
        notBefore: new Date().toISOString(),
        notAfter: new Date().toISOString(),
        serial: '01',
        fingerprintSha256: '',
        hasPrivateKey: true,
      },
    ],
  };
  const ctx = createWssContext({ keystores: () => Promise.resolve(keystore) });

  const dir = await mkdtemp(join(tmpdir(), 'wirebench-xmlsec-'));
  const certPath = join(dir, 'cert.pem');
  await writeFile(certPath, signer.certPem, 'utf8');

  let failures = 0;
  let first: string | undefined;
  try {
    for (const keyIdentifierType of KEY_IDENTIFIERS) {
      for (const algorithms of ALGORITHMS) {
        const name = `${keyIdentifierType}-${algorithms.signatureAlgorithm}`;
        const entry: WssSignatureEntry = {
          kind: 'signature',
          keystoreRef: 'ks',
          keyIdentifierType,
          canonicalization: 'exc-c14n',
          useSingleCertificate: true,
          parts: [
            { name: 'Body', namespace: SOAP11_NS, encode: 'Content' },
            { name: 'Timestamp', namespace: WSU_NS, encode: 'Content' },
          ],
          ...algorithms,
        };
        const file = join(dir, `${name}.xml`);
        const xml = await applyOutgoingWss(ENVELOPE, configFor(entry), ctx);
        await writeFile(file, xml, 'utf8');
        first ??= file;
        const result = spawnSync('xmlsec1', xmlsecVerifyArgs(file, certPath), { encoding: 'utf8' });
        if (result.status === 0) {
          console.log(`ok   ${name}`);
        } else {
          failures += 1;
          console.error(`FAIL ${name}\n${result.stderr ?? ''}`);
        }
      }
    }

    // One SOAP 1.2 case: the signature code is envelope-version-agnostic, and this catches a
    // regression that hardcodes the 1.1 namespace somewhere along the way.
    {
      const name = 'soap12-BinarySecurityToken-rsa-sha256';
      const entry: WssSignatureEntry = {
        kind: 'signature',
        keystoreRef: 'ks',
        keyIdentifierType: 'BinarySecurityToken',
        canonicalization: 'exc-c14n',
        useSingleCertificate: true,
        parts: [
          { name: 'Body', namespace: SOAP11_NS, encode: 'Content' },
          { name: 'Timestamp', namespace: WSU_NS, encode: 'Content' },
        ],
        signatureAlgorithm: 'rsa-sha256',
        digestAlgorithm: 'sha256',
      };
      const file = join(dir, `${name}.xml`);
      const xml = await applyOutgoingWss(SOAP12_ENVELOPE, configFor(entry), ctx);
      await writeFile(file, xml, 'utf8');
      const result = spawnSync('xmlsec1', xmlsecVerifyArgs(file, certPath), { encoding: 'utf8' });
      if (result.status === 0) {
        console.log(`ok   ${name}`);
      } else {
        failures += 1;
        console.error(`FAIL ${name}\n${result.stderr ?? ''}`);
      }
    }

    // One case whose Body carries a QName only in an attribute value (Finding 1): proves the
    // InclusiveNamespaces PrefixList this build emits actually lets an independent
    // implementation resolve it, not just this build's own self-consistent canonical form.
    {
      const name = 'qname-content-BinarySecurityToken-rsa-sha256';
      const entry: WssSignatureEntry = {
        kind: 'signature',
        keystoreRef: 'ks',
        keyIdentifierType: 'BinarySecurityToken',
        canonicalization: 'exc-c14n',
        useSingleCertificate: true,
        parts: [
          { name: 'Body', namespace: SOAP11_NS, encode: 'Content' },
          { name: 'Timestamp', namespace: WSU_NS, encode: 'Content' },
        ],
        signatureAlgorithm: 'rsa-sha256',
        digestAlgorithm: 'sha256',
      };
      const file = join(dir, `${name}.xml`);
      const xml = await applyOutgoingWss(QNAME_ENVELOPE, configFor(entry), ctx);
      await writeFile(file, xml, 'utf8');
      const result = spawnSync('xmlsec1', xmlsecVerifyArgs(file, certPath), { encoding: 'utf8' });
      if (result.status === 0) {
        console.log(`ok   ${name}`);
      } else {
        failures += 1;
        console.error(`FAIL ${name}\n${result.stderr ?? ''}`);
      }
    }

    // A tampered envelope must be rejected; a cross-check that cannot fail proves nothing.
    if (first !== undefined) {
      const tampered = join(dir, 'tampered.xml');
      const { readFile } = await import('node:fs/promises');
      await writeFile(tampered, (await readFile(first, 'utf8')).replace('>hello<', '>goodbye<'), 'utf8');
      const result = spawnSync('xmlsec1', xmlsecVerifyArgs(tampered, certPath), { encoding: 'utf8' });
      if (result.status === 0) {
        failures += 1;
        console.error('FAIL tampered envelope verified — the cross-check is not actually checking anything');
      } else {
        console.log('ok   tampered envelope rejected');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`${failures} xmlsec1 case(s) failed`);
    process.exit(1);
  }
  console.log('xmlsec1 cross-check passed');
}

await main();
