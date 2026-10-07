/**
 * The debugger's per-reference report (#57, SC-WD1/SC-WD2): which reference failed, its expected
 * and computed digest, the transforms used, and whether the SignatureValue holds on its own.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ExclusiveCanonicalization, SignedXml } from 'xml-crypto';
import type { Element } from '@xmldom/xmldom';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { loadKeystore } from '../../../../src/keystore/index.js';
import { createWssContext, DEFAULT_WSS_SIGNATURE_PARTS } from '../../../../src/wss/model.js';
import { verifySignature } from '../../../../src/wss/outgoing/signature.js';
import { processIncomingWss } from '../../../../src/wss/incoming/index.js';
import { algorithmName } from '../../../../src/wss/incoming/check.js';
import { internalsOf } from '../../../../src/wss/incoming/xml-crypto-seam.js';
import { parseXml } from '../../../../src/xml/parse.js';
import { serializeXml } from '../../../../src/xml/serialize.js';
import { NS } from '../../../../src/xml/namespaces.js';
import type { WssOutgoingConfig } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><Ping>hello</Ping></soapenv:Body></soapenv:Envelope>';

const ca = generateTestCa();
const signer = generateSigningCert(ca);
const store = loadKeystore(Buffer.from(`${signer.certPem}\n${signer.keyPem}`, 'utf-8'), { type: 'pem' });
const truststore = loadKeystore(Buffer.from(signer.certPem, 'utf-8'), { type: 'pem' });

const CONFIG: WssOutgoingConfig = {
  id: 'o',
  name: 'O',
  mustUnderstand: false,
  entries: [
    { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
    {
      kind: 'signature',
      keystoreRef: 'k',
      keyIdentifierType: 'BinarySecurityToken',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: DEFAULT_WSS_SIGNATURE_PARTS.map((part) => ({ ...part })),
    },
  ],
};

async function signed(): Promise<string> {
  return await applyOutgoingWss(ENVELOPE, CONFIG, createWssContext({ keystores: () => Promise.resolve(store) }));
}

/** `xml` with the first character of its SignatureValue changed. */
function breakSignatureValue(xml: string): string {
  return xml.replace(
    /<ds:SignatureValue>([A-Za-z0-9+/])/,
    (_match, first: string) => `<ds:SignatureValue>${first === 'A' ? 'B' : 'A'}`,
  );
}

/** The exc-c14n sha256 digest of the Body of `xml`, computed independently of the debugger. */
function bodyDigest(xml: string): string {
  const body = parseXml(xml).getElementsByTagNameNS(NS.SOAP11_ENV, 'Body').item(0) as Element;
  const canonical = new ExclusiveCanonicalization().process(body as never, {
    inclusiveNamespacesPrefixList: ['soapenv'],
  });
  return createHash('sha256').update(canonical, 'utf8').digest('base64');
}

const incoming = {
  id: 'i',
  name: 'I',
  signatureKeystoreRef: 't',
  requireSignature: true,
  requireTimestamp: false,
  timestampSkewSeconds: 300,
  verifyChain: false,
} as const;

describe('signature check', () => {
  it('reports every reference of a valid signature as matching', async () => {
    const result = verifySignature(await signed(), { certPem: signer.certPem });
    expect(result.ok).toBe(true);
    expect(result.check).toMatchObject({
      canonicalization: 'exc-c14n',
      signatureMethod: 'rsa-sha256',
      signatureValueOk: true,
    });
    expect(result.check?.references).toHaveLength(2);
    for (const reference of result.check?.references ?? []) {
      expect(reference).toMatchObject({ ok: true, digestAlgorithm: 'sha256', transforms: ['exc-c14n'] });
      expect(reference.computedDigest).toBe(reference.expectedDigest);
    }
  });

  it('names the tampered reference with its expected and computed digest', async () => {
    const xml = (await signed()).replace('<Ping>hello</Ping>', '<Ping>HELLO</Ping>');
    const result = verifySignature(xml, { certPem: signer.certPem });
    expect(result.ok).toBe(false);
    const body = result.check?.references.find((reference) => reference.element === 'Body');
    expect(body).toMatchObject({ ok: false, digestAlgorithm: 'sha256', transforms: ['exc-c14n'] });
    expect(body?.inclusivePrefixes).toContain('soapenv');
    expect(body?.computedDigest).toBe(bodyDigest(xml));
    expect(body?.computedDigest).not.toBe(body?.expectedDigest);
    // Only the Body changed: the Timestamp still matches, and so does SignedInfo's signature.
    expect(result.check?.references.find((reference) => reference.element === 'Timestamp')?.ok).toBe(true);
    expect(result.check?.signatureValueOk).toBe(true);
  });

  it('tells a broken SignatureValue apart from a changed payload', async () => {
    const result = verifySignature(breakSignatureValue(await signed()), { certPem: signer.certPem });
    expect(result.ok).toBe(false);
    expect(result.check?.references.every((reference) => reference.ok)).toBe(true);
    expect(result.check?.signatureValueOk).toBe(false);
  });

  it('reports a reference to an id no element carries', async () => {
    const xml = (await signed()).replace(/(<soapenv:Body[^>]*wsu:Id=")Id-/, '$1Gone-');
    const result = verifySignature(xml, { certPem: signer.certPem });
    const missing = result.check?.references.find((reference) => reference.element === undefined);
    expect(missing).toMatchObject({ ok: false, problem: 'No element in the message carries this id.' });
    expect(missing?.computedDigest).toBeUndefined();
  });

  it('says a reference could not be checked when its id is gone', async () => {
    const ctx = createWssContext({ keystores: () => Promise.resolve(truststore) });
    const xml = (await signed()).replace(/(<soapenv:Body[^>]*wsu:Id=")Id-/, '$1Gone-');
    const result = await processIncomingWss(xml, incoming, ctx);
    expect(result.actions[0]?.detail).toMatch(
      /^Reference #Id-[\w-]+ could not be checked: No element in the message carries this id\.$/,
    );
  });

  it('puts the cause in the signature action', async () => {
    const ctx = createWssContext({ keystores: () => Promise.resolve(truststore) });
    const tampered = (await signed()).replace('<Ping>hello</Ping>', '<Ping>HELLO</Ping>');
    const result = await processIncomingWss(tampered, incoming, ctx);
    const action = result.actions.find((candidate) => candidate.check !== undefined);
    expect(action?.detail).toMatch(
      /^Reference #Id-[\w-]+ \(Body\) does not match: the digest computed with exc-c14n and sha256 differs from the one in the message\.$/,
    );

    const second = await processIncomingWss(breakSignatureValue(await signed()), incoming, ctx);
    expect(second.actions[0]?.detail).toBe(
      "Every reference matches, but the SignatureValue does not verify with the signer's certificate: " +
        'SignedInfo was changed, or the message names the wrong certificate.',
    );
  });

  it('names algorithms by their short names and leaves unknown URIs alone', () => {
    expect(algorithmName('http://www.w3.org/2000/09/xmldsig#enveloped-signature')).toBe('enveloped-signature');
    expect(algorithmName('urn:example')).toBe('urn:example');
    expect(algorithmName(undefined)).toBe('unknown');
  });
});

describe('xml-crypto seam', () => {
  it('still finds the private members the debugger relies on', async () => {
    const xml = await signed();
    const verifier = new SignedXml({
      idMode: 'wssecurity',
      publicCert: signer.certPem,
      getCertFromKeyInfo: () => null,
    });
    const signature = parseXml(xml).getElementsByTagNameNS(NS.DS, 'Signature').item(0) as Element;
    verifier.loadSignature(serializeXml(signature));
    const internals = internalsOf(verifier);
    expect(typeof internals.getCanonReferenceXml).toBe('function');
    expect(typeof internals.findHashAlgorithm).toBe('function');
    expect(typeof internals.getCanonSignedInfoXml).toBe('function');
    expect(typeof internals.findSignatureAlgorithm).toBe('function');
    expect(typeof internals.signatureValue).toBe('string');
    expect(internals.signatureAlgorithm).toBe('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
    expect(internals.canonicalizationAlgorithm).toBe('http://www.w3.org/2001/10/xml-exc-c14n#');
    expect(internals.idAttributes).toContain('Id');
  });
});
