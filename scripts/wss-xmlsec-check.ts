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
 * The same script then cross-checks **encryption**, for every symmetric x key-transport
 * algorithm combination:
 *
 *   xmlsec1 --decrypt --privkey-pem key.pem,cert.pem \
 *     --node-name http://www.w3.org/2001/04/xmlenc#:EncryptedKey <case>.xml
 *
 * and compares the decrypted output to the original envelope (after stripping the
 * `wsse:Security` header and normalising whitespace). `--node-name` points xmlsec1 at the
 * header's `xenc:EncryptedKey` rather than the `xenc:EncryptedData`, because the path from the
 * data back to the key runs through a `wsse:SecurityTokenReference` — a WS-Security
 * convention, not an XML-Enc one. Where xmlsec1 still cannot follow it, the case is retried
 * with the `EncryptedKey` moved inline into the `EncryptedData`'s `ds:KeyInfo`: the same bytes
 * this build produced, rearranged into the plain XML-Enc shape, so the RSA wrapping and the
 * AES ciphertext are still checked against the reference implementation. AES-GCM needs
 * xmlsec1 >= 1.2.27 with the OpenSSL backend and is skipped with a note on older builds. One
 * tampered ciphertext must fail to decrypt, and one sign-then-encrypt case is decrypted and
 * then verified, both with xmlsec1.
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
  WssEncryptionEntry,
  WssEntry,
  WssKeyIdentifierType,
  WssKeyTransportAlgorithm,
  WssOutgoingConfig,
  WssSignatureEntry,
  WssSymmetricAlgorithm,
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

/** `xmlsec1`'s version as `[major, minor, patch]`, or `undefined` when it cannot be read. */
function xmlsecVersion(): readonly [number, number, number] | undefined {
  const probe = spawnSync('xmlsec1', ['--version'], { encoding: 'utf8' });
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${probe.stdout ?? ''}${probe.stderr ?? ''}`);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * AES-GCM arrived in xmlsec 1.2.27 (and only with the OpenSSL backend). Older builds reject the
 * `xmlenc11` algorithm identifiers outright, which is a missing feature rather than a bug in
 * what this build emits — so those cases are skipped with a note instead of failing.
 */
function supportsGcm(version: readonly [number, number, number] | undefined): boolean {
  if (version === undefined) {
    return false;
  }
  const [major, minor, patch] = version;
  return major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 27)));
}

/**
 * xmlsec 1.3 made key lookup strict: a key supplied on the command line is only used when it
 * matches the document's own `KeyInfo` (by name, by certificate, …). WS-Security identifies
 * keys by `SecurityTokenReference` forms xmlsec has no reason to follow, so under 1.3 every
 * case fails with `KEY-NOT-FOUND` unless the pre-1.3 behaviour is asked for explicitly. The
 * flag does not exist on 1.2, hence the version check rather than passing it unconditionally.
 */
function supportsLaxKeySearch(version: readonly [number, number, number] | undefined): boolean {
  if (version === undefined) {
    return false;
  }
  const [major, minor] = version;
  return major > 1 || (major === 1 && minor >= 3);
}

/** `['--lax-key-search']` on xmlsec >= 1.3, where key search is strict by default; else `[]`. */
export function laxKeySearchArgs(version: readonly [number, number, number] | undefined): string[] {
  return supportsLaxKeySearch(version) ? ['--lax-key-search'] : [];
}

/** The `xmlsec1 --decrypt` argument list for `file`, unwrapping with `keyPath` (`key.pem,cert.pem`). */
export function xmlsecDecryptArgs(
  file: string,
  keyPath: string,
  nodeName?: string,
  extraArgs: readonly string[] = [],
): string[] {
  return [
    '--decrypt',
    '--privkey-pem',
    keyPath,
    ...extraArgs,
    ...(nodeName === undefined ? [] : ['--node-name', nodeName]),
    file,
  ];
}

/** Everything between tags collapsed away, so two equivalent serializations compare equal. */
function normalizeXml(xml: string): string {
  return xml
    .replace(/<\?xml[^?]*\?>/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

/** The envelope without its `wsse:Security` header — the part decryption is supposed to restore. */
function withoutSecurityHeader(xml: string): string {
  return normalizeXml(
    xml
      .replace(/<wsse:Security[\s\S]*?<\/wsse:Security>/g, '')
      .replace(/<soapenv:Header\s*\/>|<soapenv:Header><\/soapenv:Header>/g, ''),
  );
}

/**
 * The same envelope with the `xenc:EncryptedKey` moved out of the `wsse:Security` header and
 * into the `xenc:EncryptedData`'s own `ds:KeyInfo`, replacing the `wsse:SecurityTokenReference`
 * that pointed at it.
 *
 * Nothing is re-encrypted: this is a pure re-arrangement of the elements this build produced,
 * and it exists because the WS-Security arrangement (one EncryptedKey in the header, found
 * through an STR) is a *WS-Security* convention that plain `xmlsec1` has no reason to know.
 * Decrypting the rearranged document still cross-checks the thing worth cross-checking — the
 * RSA key wrapping and the AES ciphertext this build wrote — against the reference
 * implementation; it is only used when xmlsec1 cannot follow the STR itself.
 */
function inlineEncryptedKey(xml: string): string | undefined {
  const keyMatch = /<xenc:EncryptedKey[\s\S]*?<\/xenc:EncryptedKey>/.exec(xml);
  if (keyMatch === null) {
    return undefined;
  }
  const encryptedKey = keyMatch[0].replace(/<xenc:ReferenceList>[\s\S]*?<\/xenc:ReferenceList>/, '');
  const withoutKey = xml.replace(keyMatch[0], '');
  // Anchored inside the EncryptedData's own ds:KeyInfo: in a sign-then-encrypt envelope the
  // *first* SecurityTokenReference in the document is the ds:Signature's, and replacing that
  // one would both destroy the signature's key reference and leave the EncryptedData without
  // a key to find.
  const dataMatch = /<xenc:EncryptedData[\s\S]*?<\/xenc:EncryptedData>/.exec(withoutKey);
  if (dataMatch === null) {
    return undefined;
  }
  const keyInfoMatch = /<ds:KeyInfo[\s>][\s\S]*?<\/ds:KeyInfo>/.exec(dataMatch[0]);
  if (keyInfoMatch === null) {
    return undefined;
  }
  const keyInfo = keyInfoMatch[0].replace(
    /<wsse:SecurityTokenReference[^>]*>[\s\S]*?<\/wsse:SecurityTokenReference>/,
    encryptedKey,
  );
  if (keyInfo === keyInfoMatch[0]) {
    return undefined;
  }
  return withoutKey.replace(dataMatch[0], dataMatch[0].replace(keyInfoMatch[0], keyInfo));
}

/** The `xmlsec1 --verify` argument list for `file`, verifying against `certPath`. */
export function xmlsecVerifyArgs(file: string, certPath: string, extraArgs: readonly string[] = []): string[] {
  return [
    // Options go *after* the command: xmlsec treats the first argument as the command name.
    '--verify',
    ...extraArgs,
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

/** The outgoing configuration for one case: a Timestamp followed by the given entries. */
function configFor(...entries: readonly WssEntry[]): WssOutgoingConfig {
  return {
    id: 'xmlsec-check',
    name: 'xmlsec check',
    mustUnderstand: false,
    entries: [{ kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false }, ...entries],
  };
}

/** The signature entry every signing case uses, with `overrides` applied. */
function signatureEntry(overrides: Partial<WssSignatureEntry> = {}): WssSignatureEntry {
  return {
    kind: 'signature',
    keystoreRef: 'ks',
    keyIdentifierType: 'BinarySecurityToken',
    canonicalization: 'exc-c14n',
    useSingleCertificate: true,
    signatureAlgorithm: 'rsa-sha256',
    digestAlgorithm: 'sha256',
    parts: [
      { name: 'Body', namespace: SOAP11_NS, encode: 'Content' },
      { name: 'Timestamp', namespace: WSU_NS, encode: 'Content' },
    ],
    ...overrides,
  };
}

/** The encryption entry every decrypt case uses, with `overrides` applied. */
function encryptionEntry(overrides: Partial<WssEncryptionEntry> = {}): WssEncryptionEntry {
  return {
    kind: 'encryption',
    keystoreRef: 'ks',
    keyIdentifierType: 'BinarySecurityToken',
    symmetricAlgorithm: 'aes256-gcm',
    keyTransportAlgorithm: 'rsa-oaep',
    embedKey: true,
    encryptSymmetricKey: true,
    parts: [{ name: 'Body', namespace: SOAP11_NS, encode: 'Content' }],
    ...overrides,
  };
}

/** The `xenc:EncryptedKey` element name, for `--node-name`. */
const ENCRYPTED_KEY_NODE = 'http://www.w3.org/2001/04/xmlenc#:EncryptedKey';

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
  // `--privkey-pem key.pem,cert.pem` hands xmlsec1 the private key *and* the certificate that
  // goes with it, so it can match the EncryptedKey's key identifier back to this key.
  const keyPath = join(dir, 'key.pem');
  await writeFile(keyPath, signer.keyPem, 'utf8');
  const privkeyArgument = `${keyPath},${certPath}`;
  const laxArgs = laxKeySearchArgs(xmlsecVersion());

  let failures = 0;
  let first: string | undefined;
  try {
    for (const keyIdentifierType of KEY_IDENTIFIERS) {
      for (const algorithms of ALGORITHMS) {
        const name = `${keyIdentifierType}-${algorithms.signatureAlgorithm}`;
        const entry = signatureEntry({ keyIdentifierType, ...algorithms });
        const file = join(dir, `${name}.xml`);
        const xml = await applyOutgoingWss(ENVELOPE, configFor(entry), ctx);
        await writeFile(file, xml, 'utf8');
        first ??= file;
        const result = spawnSync('xmlsec1', xmlsecVerifyArgs(file, certPath, laxArgs), { encoding: 'utf8' });
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
      const entry = signatureEntry();
      const file = join(dir, `${name}.xml`);
      const xml = await applyOutgoingWss(SOAP12_ENVELOPE, configFor(entry), ctx);
      await writeFile(file, xml, 'utf8');
      const result = spawnSync('xmlsec1', xmlsecVerifyArgs(file, certPath, laxArgs), { encoding: 'utf8' });
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
      const entry = signatureEntry();
      const file = join(dir, `${name}.xml`);
      const xml = await applyOutgoingWss(QNAME_ENVELOPE, configFor(entry), ctx);
      await writeFile(file, xml, 'utf8');
      const result = spawnSync('xmlsec1', xmlsecVerifyArgs(file, certPath, laxArgs), { encoding: 'utf8' });
      if (result.status === 0) {
        console.log(`ok   ${name}`);
      } else {
        failures += 1;
        console.error(`FAIL ${name}\n${result.stderr ?? ''}`);
      }
    }

    // --- decryption -----------------------------------------------------------------------
    //
    // `xmlsec1 --decrypt --privkey-pem key.pem,cert.pem <file>` is run on the envelope as this
    // build writes it; when xmlsec1 cannot follow the WS-Security `SecurityTokenReference`
    // from the EncryptedData to the header's EncryptedKey (an arrangement the WS-Security
    // profile defines, not XML-Enc), the same document is retried with the EncryptedKey
    // inlined into the EncryptedData's KeyInfo — still this build's own ciphertext and key
    // wrapping, only rearranged into the plain XML-Enc shape xmlsec1 expects.
    const gcm = supportsGcm(xmlsecVersion());
    if (!gcm) {
      console.log('skip AES-GCM decrypt cases — xmlsec1 is older than 1.2.27 (or has no OpenSSL backend)');
    }
    const symmetricAlgorithms: readonly WssSymmetricAlgorithm[] = gcm
      ? ['aes128-cbc', 'aes256-cbc', 'aes128-gcm', 'aes256-gcm']
      : ['aes128-cbc', 'aes256-cbc'];
    const transports: readonly WssKeyTransportAlgorithm[] = ['rsa-oaep', 'rsa-1_5'];
    const expected = withoutSecurityHeader(ENVELOPE);

    /** Decrypts `xml` with xmlsec1 and compares the result to the original envelope. */
    const decryptCase = async (name: string, xml: string): Promise<void> => {
      const file = join(dir, `${name}.xml`);
      await writeFile(file, xml, 'utf8');
      let result = spawnSync('xmlsec1', xmlsecDecryptArgs(file, privkeyArgument, ENCRYPTED_KEY_NODE, laxArgs), {
        encoding: 'utf8',
      });
      let note = '';
      if (result.status !== 0) {
        const inlined = inlineEncryptedKey(xml);
        if (inlined !== undefined) {
          const inlinedFile = join(dir, `${name}-inlined.xml`);
          await writeFile(inlinedFile, inlined, 'utf8');
          result = spawnSync('xmlsec1', xmlsecDecryptArgs(inlinedFile, privkeyArgument, undefined, laxArgs), {
            encoding: 'utf8',
          });
          note = ' (via inlined EncryptedKey)';
        }
      }
      if (result.status !== 0) {
        failures += 1;
        console.error(`FAIL ${name}\n${result.stderr ?? ''}`);
        return;
      }
      if (withoutSecurityHeader(result.stdout ?? '') !== expected) {
        failures += 1;
        console.error(`FAIL ${name} — decrypted output differs from the original envelope\n${result.stdout ?? ''}`);
        return;
      }
      console.log(`ok   ${name}${note}`);
    };

    let firstEncrypted: string | undefined;
    for (const symmetricAlgorithm of symmetricAlgorithms) {
      for (const keyTransportAlgorithm of transports) {
        const name = `decrypt-${symmetricAlgorithm}-${keyTransportAlgorithm}`;
        const xml = await applyOutgoingWss(
          ENVELOPE,
          configFor(encryptionEntry({ symmetricAlgorithm, keyTransportAlgorithm })),
          ctx,
        );
        firstEncrypted ??= xml;
        await decryptCase(name, xml);
      }
    }

    // Sign, then encrypt: xmlsec1 has to decrypt the Body back before the signature it carries
    // can verify — exactly what a receiver does, and the ordering claim the entry list makes.
    {
      const name = 'sign-then-encrypt';
      const xml = await applyOutgoingWss(
        ENVELOPE,
        configFor(signatureEntry(), encryptionEntry({ symmetricAlgorithm: 'aes256-cbc' })),
        ctx,
      );
      const file = join(dir, `${name}.xml`);
      await writeFile(file, xml, 'utf8');
      let decrypted = spawnSync('xmlsec1', xmlsecDecryptArgs(file, privkeyArgument, ENCRYPTED_KEY_NODE, laxArgs), {
        encoding: 'utf8',
      });
      if (decrypted.status !== 0) {
        const inlined = inlineEncryptedKey(xml);
        if (inlined !== undefined) {
          const inlinedFile = join(dir, `${name}-inlined.xml`);
          await writeFile(inlinedFile, inlined, 'utf8');
          decrypted = spawnSync('xmlsec1', xmlsecDecryptArgs(inlinedFile, privkeyArgument, undefined, laxArgs), {
            encoding: 'utf8',
          });
        }
      }
      if (decrypted.status !== 0) {
        failures += 1;
        console.error(`FAIL ${name} (decrypt)\n${decrypted.stderr ?? ''}`);
      } else {
        const verifyFile = join(dir, `${name}-decrypted.xml`);
        await writeFile(verifyFile, decrypted.stdout ?? '', 'utf8');
        const verified = spawnSync('xmlsec1', xmlsecVerifyArgs(verifyFile, certPath, laxArgs), { encoding: 'utf8' });
        if (verified.status === 0) {
          console.log(`ok   ${name}`);
        } else {
          failures += 1;
          console.error(`FAIL ${name} (verify after decrypt)\n${verified.stderr ?? ''}`);
        }
      }
    }

    // A tampered ciphertext must not decrypt: a cross-check that cannot fail proves nothing.
    if (firstEncrypted !== undefined) {
      const name = 'tampered-ciphertext';
      const tampered = firstEncrypted.replace(
        /(<xenc:EncryptedData[\s\S]*?<xenc:CipherValue>)([A-Za-z0-9+/=]{20,})(<\/xenc:CipherValue>)/,
        (_match, open: string, value: string, close: string) =>
          `${open}${value.slice(0, -8)}${value.slice(-8, -7) === 'A' ? 'B' : 'A'}${value.slice(-7)}${close}`,
      );
      const file = join(dir, `${name}.xml`);
      await writeFile(file, tampered, 'utf8');
      const direct = spawnSync('xmlsec1', xmlsecDecryptArgs(file, privkeyArgument, ENCRYPTED_KEY_NODE, laxArgs), {
        encoding: 'utf8',
      });
      const inlined = inlineEncryptedKey(tampered);
      let viaInlined = { status: 1, stdout: '' } as { status: number | null; stdout?: string };
      if (inlined !== undefined) {
        const inlinedFile = join(dir, `${name}-inlined.xml`);
        await writeFile(inlinedFile, inlined, 'utf8');
        viaInlined = spawnSync('xmlsec1', xmlsecDecryptArgs(inlinedFile, privkeyArgument, undefined, laxArgs), {
          encoding: 'utf8',
        });
      }
      const restored = (result: { status: number | null; stdout?: string }): boolean =>
        result.status === 0 && withoutSecurityHeader(result.stdout ?? '') === expected;
      if (restored(direct) || restored(viaInlined)) {
        failures += 1;
        console.error(`FAIL ${name} — tampered ciphertext decrypted to the original envelope`);
      } else {
        console.log(`ok   ${name} rejected`);
      }
    }

    // A tampered envelope must be rejected; a cross-check that cannot fail proves nothing.
    if (first !== undefined) {
      const tampered = join(dir, 'tampered.xml');
      const { readFile } = await import('node:fs/promises');
      const signed = await readFile(first, 'utf8');
      const tamperedXml = signed.replace('>hello<', '>goodbye<');
      if (tamperedXml === signed) {
        throw new Error('the tamper did not change the signed envelope; the negative case would prove nothing');
      }
      await writeFile(tampered, tamperedXml, 'utf8');
      const result = spawnSync('xmlsec1', xmlsecVerifyArgs(tampered, certPath, laxArgs), { encoding: 'utf8' });
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
