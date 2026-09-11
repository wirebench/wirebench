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
 * not know the WS-Security schema), `--pubkey-cert-pem` supplies the key to verify against —
 * so the document's own `KeyInfo` is never trusted — and `--enabled-key-data raw-x509-cert`
 * stops xmlsec1 from trying to resolve the `SecurityTokenReference` itself. Finally one signed
 * envelope is tampered with and expected to FAIL.
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

const ENVELOPE =
  `<soapenv:Envelope xmlns:soapenv="${SOAP11_NS}">` +
  '<soapenv:Body><tns:Echo xmlns:tns="urn:wirebench"><tns:Text>hello</tns:Text></tns:Echo></soapenv:Body>' +
  '</soapenv:Envelope>';

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
