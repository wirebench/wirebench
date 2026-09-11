import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { verifySignature } from '../../../../src/wss/outgoing/signature.js';
import { createWssContext } from '../../../../src/wss/model.js';
import { WSS_TOKEN_TYPES } from '../../../../src/wss/key-identifiers.js';
import { NS } from '../../../../src/xml/namespaces.js';
import { generateClientCert, generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore, KeystoreAlias } from '../../../../src/wss/keystore/model.js';
import type {
  WssDigestAlgorithm,
  WssEntry,
  WssKeyIdentifierType,
  WssOutgoingConfig,
  WssPart,
  WssSignatureAlgorithm,
  WssSignatureEntry,
} from '../../../../src/wss/model.js';

const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><tns:Echo xmlns:tns="urn:test"><tns:Text>hello</tns:Text></tns:Echo></soapenv:Body>' +
  '</soapenv:Envelope>';

const ca = generateTestCa();
const signer = generateSigningCert(ca);
const noSki = generateClientCert(ca);

/** A one-alias keystore around a PEM pair, the shape `WssContext.keystores` hands back. */
function keystoreOf(cert: { certPem: string; keyPem: string }, chainPem: readonly string[] = [ca.certPem]): Keystore {
  const alias: KeystoreAlias = {
    alias: 'signer',
    certPem: cert.certPem,
    keyPem: cert.keyPem,
    chainPem,
    subject: 'CN=signer',
    issuer: 'CN=ca',
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z',
    serial: '01',
    fingerprintSha256: 'AA:BB',
    hasPrivateKey: true,
  };
  return { type: 'pem', aliases: [alias] };
}

let uuidCounter = 0;

function ctxFor(keystore: Keystore) {
  uuidCounter = 0;
  return createWssContext({
    keystores: () => Promise.resolve(keystore),
    clock: () => new Date('2026-09-11T10:00:00.000Z'),
    uuid: () => `u${++uuidCounter}`,
  });
}

const BODY_PART: WssPart = { name: 'Body', namespace: NS.SOAP11_ENV, encode: 'Content' };
const TIMESTAMP_PART: WssPart = { name: 'Timestamp', namespace: NS.WSU, encode: 'Content' };

function signatureEntry(overrides: Partial<WssSignatureEntry> = {}): WssSignatureEntry {
  return {
    kind: 'signature',
    keystoreRef: 'ks-1',
    keyIdentifierType: 'BinarySecurityToken',
    signatureAlgorithm: 'rsa-sha256',
    digestAlgorithm: 'sha256',
    canonicalization: 'exc-c14n',
    useSingleCertificate: true,
    parts: [BODY_PART, TIMESTAMP_PART],
    ...overrides,
  };
}

function config(entries: readonly WssEntry[]): WssOutgoingConfig {
  return { id: 'out-1', name: 'Gateway', mustUnderstand: false, entries };
}

const TIMESTAMP_ENTRY: WssEntry = { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false };

/** Signs `SOAP11` with a Timestamp followed by `entry`. */
async function signed(entry: WssSignatureEntry, keystore = keystoreOf(signer)): Promise<string> {
  return applyOutgoingWss(SOAP11, config([TIMESTAMP_ENTRY, entry]), ctxFor(keystore));
}

const KEY_IDENTIFIERS: readonly WssKeyIdentifierType[] = [
  'BinarySecurityToken',
  'IssuerSerial',
  'SubjectKeyIdentifier',
  'X509KeyIdentifier',
  'Thumbprint',
];

const ALGORITHMS: readonly (readonly [WssSignatureAlgorithm, WssDigestAlgorithm])[] = [
  ['rsa-sha256', 'sha256'],
  ['rsa-sha1', 'sha1'],
];

describe('signEnvelope', () => {
  for (const keyIdentifierType of KEY_IDENTIFIERS) {
    for (const [signatureAlgorithm, digestAlgorithm] of ALGORITHMS) {
      it(`signs and self-verifies with ${keyIdentifierType} / ${signatureAlgorithm}`, async () => {
        const xml = await signed(signatureEntry({ keyIdentifierType, signatureAlgorithm, digestAlgorithm }));
        const result = verifySignature(xml, { certPem: signer.certPem });
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        expect(result.references).toHaveLength(2);
      });
    }
  }

  it('emits the expected Security header for a BinarySecurityToken signature', async () => {
    const xml = await signed(signatureEntry());
    const normalized = xml
      .replace(/wsu:Id="TS-[^"]+"/g, 'wsu:Id="TS-@"')
      .replace(/wsu:Id="Id-[^"]+"/g, 'wsu:Id="Id-@"')
      .replace(/(URI="#|wsu:Id=")X509-[^"]+"/g, '$1X509-@"')
      .replace(/<ds:DigestValue>[^<]+<\/ds:DigestValue>/g, '<ds:DigestValue>@</ds:DigestValue>')
      .replace(/<ds:SignatureValue>[^<]+<\/ds:SignatureValue>/g, '<ds:SignatureValue>@</ds:SignatureValue>')
      .replace(/(ValueType="[^"]*#X509v3">)[^<]+</g, '$1@<');
    expect(normalized).toMatchSnapshot();
  });

  it('references the Timestamp and the Body by their wsu:Id', async () => {
    const xml = await signed(signatureEntry());
    const { references } = verifySignature(xml, { certPem: signer.certPem });
    for (const id of references) {
      expect(xml).toContain(`wsu:Id="${id}"`);
    }
  });

  it('fails verification when the body is tampered with', async () => {
    const xml = await signed(signatureEntry());
    const tampered = xml.replace('>hello<', '>goodbye<');
    expect(tampered).not.toEqual(xml);
    const result = verifySignature(tampered, { certPem: signer.certPem });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('fails verification against a different certificate', async () => {
    const xml = await signed(signatureEntry());
    expect(verifySignature(xml, { certPem: noSki.certPem }).ok).toBe(false);
  });

  it('signs a custom part named by namespace and local name', async () => {
    const entry = signatureEntry({ parts: [{ name: 'Echo', namespace: 'urn:test', encode: 'Element' }] });
    const xml = await signed(entry);
    const result = verifySignature(xml, { certPem: signer.certPem });
    expect(result.ok).toBe(true);
    expect(result.references).toHaveLength(1);
    expect(xml).toMatch(/<tns:Echo [^>]*wsu:Id="Id-/);
  });

  it('rejects a part the message does not contain', async () => {
    const entry = signatureEntry({ parts: [{ name: 'Nope', namespace: 'urn:test', encode: 'Element' }] });
    await expect(signed(entry)).rejects.toMatchObject({
      code: 'wss-part-missing',
      details: { name: 'Nope', namespace: 'urn:test' },
    });
  });

  it('rejects SubjectKeyIdentifier for a certificate without the extension', async () => {
    await expect(
      signed(signatureEntry({ keyIdentifierType: 'SubjectKeyIdentifier' }), keystoreOf(noSki)),
    ).rejects.toMatchObject({ code: 'wss-ski-missing' });
  });

  it('emits an X509PKIPathv1 token when useSingleCertificate is false', async () => {
    const xml = await signed(signatureEntry({ useSingleCertificate: false }));
    expect(xml).toContain(WSS_TOKEN_TYPES.X509_PKI_PATH_V1);
    expect(verifySignature(xml, { certPem: signer.certPem }).ok).toBe(true);
  });

  it('signs the timestamp only when the timestamp entry comes first', async () => {
    const entry = signatureEntry();
    const ok = await applyOutgoingWss(SOAP11, config([TIMESTAMP_ENTRY, entry]), ctxFor(keystoreOf(signer)));
    expect(verifySignature(ok, { certPem: signer.certPem }).references).toHaveLength(2);
    await expect(
      applyOutgoingWss(SOAP11, config([entry, TIMESTAMP_ENTRY]), ctxFor(keystoreOf(signer))),
    ).rejects.toMatchObject({ code: 'wss-part-missing', details: { name: 'Timestamp' } });
  });

  it('reuses a wsu:Id the part already carries', async () => {
    const xml = await signed(signatureEntry());
    const timestampId = /wsu:Id="(TS-[^"]+)"/.exec(xml)?.[1];
    expect(timestampId).toBeDefined();
    expect(verifySignature(xml, { certPem: signer.certPem }).references).toContain(timestampId);
  });

  it('decrypts an encrypted private key through the secret store', async () => {
    const { createPrivateKey } = await import('node:crypto');
    const encrypted = createPrivateKey(signer.keyPem)
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'sesame' })
      .toString();
    const keystore = keystoreOf({ certPem: signer.certPem, keyPem: encrypted });
    const ctx = createWssContext({
      keystores: () => Promise.resolve(keystore),
      secrets: (ref) => Promise.resolve(ref === 'secret:key' ? 'sesame' : undefined),
      uuid: () => `u${++uuidCounter}`,
    });
    const xml = await applyOutgoingWss(
      SOAP11,
      config([TIMESTAMP_ENTRY, signatureEntry({ keyPasswordRef: 'secret:key' })]),
      ctx,
    );
    expect(verifySignature(xml, { certPem: signer.certPem }).ok).toBe(true);
  });

  it('reports a keystore that cannot be resolved', async () => {
    const ctx = createWssContext({ keystores: () => Promise.resolve(undefined) });
    await expect(applyOutgoingWss(SOAP11, config([signatureEntry()]), ctx)).rejects.toMatchObject({
      code: 'wss-keystore-missing',
    });
  });

  it('reports an alias without a private key', async () => {
    const [alias] = keystoreOf(signer).aliases;
    const rest: Record<string, unknown> = { ...(alias as KeystoreAlias), hasPrivateKey: false };
    delete rest['keyPem'];
    const withoutKey: Keystore = { type: 'pem', aliases: [rest as unknown as KeystoreAlias] };
    await expect(signed(signatureEntry(), withoutKey)).rejects.toMatchObject({ code: 'wss-signing-key-missing' });
  });

  it('carries an InclusiveNamespaces PrefixList for a QName used only in attribute content', async () => {
    // `tns` is declared on the Envelope, not on `Echo` itself, and is only "used" through the
    // value of `xsi:type` — exclusive c14n's visible-utilization rule never looks at attribute
    // *values*, so a receiver canonicalizing this reference in isolation cannot resolve `tns`
    // unless the PrefixList says to keep it in scope.
    const envelope =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:test">' +
      '<soapenv:Body><tns:Echo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="tns:Foo">' +
      '<tns:Text>hello</tns:Text></tns:Echo></soapenv:Body></soapenv:Envelope>';
    const signedXml = await applyOutgoingWss(
      envelope,
      config([TIMESTAMP_ENTRY, signatureEntry({ parts: [BODY_PART, TIMESTAMP_PART] })]),
      ctxFor(keystoreOf(signer)),
    );
    const result = verifySignature(signedXml, { certPem: signer.certPem });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const bodyTransform = /<ds:Reference URI="#Id-[^"]+">.*?PrefixList="([^"]*)"/s.exec(signedXml);
    expect(bodyTransform?.[1]?.split(' ')).toEqual(expect.arrayContaining(['soapenv', 'tns']));
  });

  it('does not redeclare xmlns:wsu on the Timestamp, which already inherits it from wsse:Security', async () => {
    const xml = await signed(signatureEntry());
    const timestampTag = /<wsu:Timestamp\b[^>]*>/.exec(xml)?.[0];
    expect(timestampTag).toBeDefined();
    expect(timestampTag).not.toContain('xmlns:wsu');
  });

  it('signs into the wsse:Security addressed to the actor, ignoring a same-named block nested in the Body', async () => {
    const nested =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soapenv:Body><tns:Echo xmlns:tns="urn:test">' +
      `<wsse:Security xmlns:wsse="${NS.WSSE}"><tns:Nope/></wsse:Security>` +
      '<tns:Text>hello</tns:Text></tns:Echo></soapenv:Body></soapenv:Envelope>';
    const xml = await applyOutgoingWss(
      nested,
      config([TIMESTAMP_ENTRY, signatureEntry({ parts: [BODY_PART, TIMESTAMP_PART] })]),
      ctxFor(keystoreOf(signer)),
    );
    const result = verifySignature(xml, { certPem: signer.certPem });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // The signature landed in the header's own Security block, not the decoy inside the Body.
    const headerSecurity = /<soapenv:Header>.*?<\/soapenv:Header>/s.exec(xml)?.[0];
    expect(headerSecurity).toContain('<ds:Signature');
    const bodySecurity = /<wsse:Security[^>]*><tns:Nope\/><\/wsse:Security>/.exec(xml)?.[0];
    expect(bodySecurity).not.toContain('ds:Signature');
  });
});

describe('verifySignature', () => {
  it('reports a document with no signature', () => {
    const result = verifySignature(SOAP11, { certPem: signer.certPem });
    expect(result.ok).toBe(false);
    expect(result.references).toEqual([]);
    expect(result.error).toContain('ds:Signature');
  });

  it('reports unparsable input', () => {
    const result = verifySignature('<not xml', { certPem: signer.certPem });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('selects the ds:Signature at options.signature.index rather than the first one', async () => {
    const first = await signed(signatureEntry());
    const rogue = await signed(signatureEntry(), keystoreOf(noSki));
    const rogueSignature = /<ds:Signature[\s\S]*?<\/ds:Signature>/.exec(rogue)?.[0] ?? '';
    expect(rogueSignature).not.toBe('');
    const merged = first.replace('<ds:Signature', `${rogueSignature}<ds:Signature`);

    // Both signings go through `ctxFor`, which pins the clock and restarts the uuid counter, so
    // the two envelopes carry byte-identical Timestamps and wsu:Ids. That is *why* a signature
    // lifted out of one still verifies against the other, and it is the whole premise of this
    // test — so assert it up front. A future change to id or timestamp generation then fails
    // here, naming the cause, instead of surfacing as an unexplained `ok === false` below.
    const withoutCredentials = (xml: string): string =>
      xml
        .replace(/<ds:Signature[\s\S]*?<\/ds:Signature>/, '')
        .replace(/<wsse:BinarySecurityToken[\s\S]*?<\/wsse:BinarySecurityToken>/, '');
    expect(withoutCredentials(rogue)).toBe(withoutCredentials(first));

    // Index 0 is the planted, unrelated signature; index 1 is the genuine one. Each `ok` is
    // paired with its `error`, so a failure reports what xml-crypto objected to rather than
    // just `expected false to be true`.
    const rogueAtZero = verifySignature(merged, { certPem: noSki.certPem, signature: { index: 0 } });
    expect(rogueAtZero.error).toBeUndefined();
    expect(rogueAtZero.ok).toBe(true);

    const genuineAtOne = verifySignature(merged, { certPem: signer.certPem, signature: { index: 1 } });
    expect(genuineAtOne.error).toBeUndefined();
    expect(genuineAtOne.ok).toBe(true);

    // The genuine signer's certificate must not validate the planted signature.
    expect(verifySignature(merged, { certPem: signer.certPem, signature: { index: 0 } }).ok).toBe(false);
  });
});
