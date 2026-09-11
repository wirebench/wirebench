/**
 * Resolving a signer out of a `ds:KeyInfo` — every X.509 token profile form — and judging the
 * `wsu:Timestamp`. The signatures here are made by the real outgoing builder, so each key
 * identifier form is exercised exactly as it goes on the wire.
 */

import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { loadKeystore } from '../../../../src/wss/keystore/index.js';
import { createWssContext, DEFAULT_WSS_SIGNATURE_PARTS } from '../../../../src/wss/model.js';
import { verifyIncoming } from '../../../../src/wss/incoming/verify.js';
import { decryptIncoming } from '../../../../src/wss/incoming/decrypt.js';
import type { Keystore } from '../../../../src/wss/keystore/model.js';
import type { WssKeyIdentifierType, WssOutgoingConfig, WssPart } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa, generateUntrustedCert } from '../../../helpers/test-certs.js';

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';

const ca = generateTestCa();
const signer = generateSigningCert(ca);

function keystoreOf(...pems: readonly string[]): Keystore {
  return loadKeystore(Buffer.from(pems.join('\n'), 'utf-8'), { type: 'pem' });
}

const signerStore = keystoreOf(signer.certPem, signer.keyPem);
const truststore = keystoreOf(signer.certPem);

/** Signs {@link ENVELOPE} with a Timestamp, referencing the certificate the given way. */
async function sign(
  keyIdentifierType: WssKeyIdentifierType,
  identity = signer,
  parts: readonly WssPart[] = DEFAULT_WSS_SIGNATURE_PARTS,
): Promise<string> {
  const config: WssOutgoingConfig = {
    id: 'o',
    name: 'O',
    mustUnderstand: false,
    entries: [
      { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
      {
        kind: 'signature',
        keystoreRef: 'k',
        keyIdentifierType,
        signatureAlgorithm: 'rsa-sha256',
        digestAlgorithm: 'sha256',
        canonicalization: 'exc-c14n',
        useSingleCertificate: true,
        parts: parts.map((part) => ({ ...part })),
      },
    ],
  };
  const store = identity === signer ? signerStore : keystoreOf(identity.certPem, identity.keyPem);
  return await applyOutgoingWss(ENVELOPE, config, createWssContext({ keystores: () => Promise.resolve(store) }));
}

const options = { clock: () => new Date(), skewSeconds: 300, verifyChain: true } as const;

describe('verifyIncoming', () => {
  it.each<WssKeyIdentifierType>([
    'BinarySecurityToken',
    'X509KeyIdentifier',
    'IssuerSerial',
    'SubjectKeyIdentifier',
    'Thumbprint',
  ])('resolves and verifies a signer referenced by %s', async (type) => {
    const xml = await sign(type);
    const result = verifyIncoming(xml, { ...options, truststore });
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0]).toMatchObject({ ok: true, trusted: true });
    expect(result.signatures[0]?.signerSubject).toContain('wirebench-signer');
    expect(result.signatures[0]?.references).toHaveLength(2);
  });

  it('cannot resolve a name-only identifier without a truststore', async () => {
    const xml = await sign('Thumbprint');
    const result = verifyIncoming(xml, options);
    expect(result.signatures[0]).toMatchObject({ ok: false, trusted: false });
    expect(result.signatures[0]?.error).toContain('could not be resolved');
  });

  it('verifies but does not trust a signer the truststore does not know', async () => {
    const xml = await sign('BinarySecurityToken', generateUntrustedCert());
    const result = verifyIncoming(xml, { ...options, truststore });
    expect(result.signatures[0]).toMatchObject({ ok: true, trusted: false });
  });

  it('reads a Timestamp with an Expires', async () => {
    const xml = await sign('BinarySecurityToken');
    const result = verifyIncoming(xml, { ...options, truststore });
    expect(result.timestamp?.fresh).toBe(true);
    expect(result.timestamp?.created).toMatch(/Z$/);
    expect(result.timestamp?.expires).toMatch(/Z$/);
  });

  it('rejects a Timestamp created in the future beyond the skew', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const xml = timestampEnvelope(`<wsu:Created>${future}</wsu:Created>`);
    const result = verifyIncoming(xml, options);
    expect(result.timestamp).toMatchObject({ fresh: false, error: 'The message was created in the future.' });
  });

  it('rejects a Timestamp older than the skew when it has no Expires', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const xml = timestampEnvelope(`<wsu:Created>${past}</wsu:Created>`);
    const result = verifyIncoming(xml, options);
    expect(result.timestamp?.fresh).toBe(false);
    expect(result.timestamp?.expires).toBeUndefined();
  });

  it('accepts a Timestamp within the skew when it has no Expires', () => {
    const xml = timestampEnvelope(`<wsu:Created>${new Date().toISOString()}</wsu:Created>`);
    expect(verifyIncoming(xml, options).timestamp?.fresh).toBe(true);
  });

  it('rejects a Timestamp whose Created is not a date', () => {
    const xml = timestampEnvelope('<wsu:Created>not-a-date</wsu:Created>');
    expect(verifyIncoming(xml, options).timestamp).toMatchObject({ fresh: false });
  });

  it('rejects an expired Timestamp', () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const xml = timestampEnvelope(
      `<wsu:Created>${past}</wsu:Created><wsu:Expires>${new Date(Date.now() - 3_600_000).toISOString()}</wsu:Expires>`,
    );
    expect(verifyIncoming(xml, options).timestamp).toMatchObject({ fresh: false, error: 'The message expired.' });
  });

  it('reports nothing for a plain or unparsable message', () => {
    expect(verifyIncoming(ENVELOPE, options)).toEqual({ signatures: [] });
    expect(verifyIncoming('<not xml', options)).toEqual({ signatures: [] });
    expect(verifyIncoming('', options)).toEqual({ signatures: [] });
  });

  it('verifies two signatures independently', async () => {
    const first = await sign('BinarySecurityToken');
    // A second, rogue signature appended to the same Security header must not make the first
    // one fail, nor borrow its trust.
    const rogue = await sign('BinarySecurityToken', generateUntrustedCert());
    const rogueSignature = /<ds:Signature[\s\S]*?<\/ds:Signature>/.exec(rogue)?.[0] ?? '';
    const rogueToken = /<wsse:BinarySecurityToken[\s\S]*?<\/wsse:BinarySecurityToken>/.exec(rogue)?.[0] ?? '';
    const merged = first.replace('</wsse:Security>', `${rogueToken}${rogueSignature}</wsse:Security>`);
    const result = verifyIncoming(merged, { ...options, truststore });
    expect(result.signatures).toHaveLength(2);
    expect(result.signatures[0]).toMatchObject({ ok: true, trusted: true });
    expect(result.signatures[1]?.trusted).toBe(false);
  });

  it('is not shifted by a decoy ds:Signature planted in the Body', async () => {
    const rogue = await sign('BinarySecurityToken', generateUntrustedCert());
    const decoy = /<ds:Signature[\s\S]*?<\/ds:Signature>/.exec(rogue)?.[0] ?? '';
    expect(decoy).not.toBe('');
    const xml = (await sign('BinarySecurityToken')).replace('<Ping/>', `<Ping/>${decoy}`);
    const result = verifyIncoming(xml, { ...options, truststore });
    expect(result.signatures).toHaveLength(2);
    // The genuine, Security-header signature still verifies over the Body it really covers …
    expect(result.signatures[0]).toMatchObject({ ok: true, trusted: true, coversBody: true });
    // … and the planted one is a visible failure rather than silently ignored.
    expect(result.signatures[1]).toMatchObject({ ok: false, trusted: false });
  });

  it('fails a signature whose reference id is duplicated', async () => {
    const xml = await sign('BinarySecurityToken');
    const bodyId = /<\w+:Body[^>]*\bwsu:Id="([^"]+)"/.exec(xml)?.[1] ?? '';
    expect(bodyId).not.toBe('');
    const planted = xml.replace(
      '<Ping/>',
      `<Ping/><Decoy xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"` +
        ` wsu:Id="${bodyId}"/>`,
    );
    const result = verifyIncoming(planted, { ...options, truststore });
    expect(result.signatures[0]?.ok).toBe(false);
    expect(result.signatures[0]?.error).toContain('duplicate-id');
  });

  it('reports a signature that does not cover the Body', async () => {
    const xml = await sign('BinarySecurityToken', signer, [
      { name: 'Timestamp', namespace: WSU_NS, encode: 'Content' },
    ]);
    const result = verifyIncoming(xml, { ...options, truststore });
    expect(result.signatures[0]).toMatchObject({ ok: true, trusted: true, coversBody: false });
    expect(result.signatures[0]?.referenceNames).toEqual(['Timestamp']);
  });

  it('matches an IssuerSerial whose X509IssuerName is rendered differently', async () => {
    const xml = await sign('IssuerSerial');
    // Same attributes, reversed and spaced: an RFC 2253 parse has to see through the rendering.
    const respaced = xml.replace(
      /<ds:X509IssuerName>([^<]*)<\/ds:X509IssuerName>/,
      (_match, dn: string) => `<ds:X509IssuerName>${dn.split(',').reverse().join(', ')}</ds:X509IssuerName>`,
    );
    expect(respaced).not.toEqual(xml);
    expect(verifyIncoming(respaced, { ...options, truststore }).signatures[0]).toMatchObject({
      ok: true,
      trusted: true,
    });
  });

  it('does not trust a pinned certificate outside its validity window', async () => {
    const xml = await sign('BinarySecurityToken');
    const later = () => new Date(Date.now() + 48 * 60 * 60 * 1000);
    const result = verifyIncoming(xml, { ...options, truststore, clock: later });
    expect(result.signatures[0]).toMatchObject({ ok: true, trusted: false });
  });

  it('ignores a truststore entry that is not a certificate', async () => {
    const xml = await sign('BinarySecurityToken');
    const broken: Keystore = {
      type: 'pem',
      aliases: [{ ...(truststore.aliases[0] as NonNullable<(typeof truststore.aliases)[0]>), certPem: 'nonsense' }],
    };
    expect(verifyIncoming(xml, { ...options, truststore: broken }).signatures[0]?.trusted).toBe(false);
  });
});

describe('decryptIncoming', () => {
  it('leaves a message that carries no XML-Encryption alone', () => {
    expect(decryptIncoming(ENVELOPE, { keystore: signerStore, alias: signerStore.aliases[0]! })).toEqual({
      xml: ENVELOPE,
      decrypted: [],
    });
  });

  it('leaves a message that only mentions XML-Encryption in its text alone', () => {
    const xml = ENVELOPE.replace(
      '<Ping/>',
      '<Ping>http://www.w3.org/2001/04/xmlenc# EncryptedKey EncryptedData</Ping>',
    );
    expect(decryptIncoming(xml, { keystore: signerStore, alias: signerStore.aliases[0]! })).toEqual({
      xml,
      decrypted: [],
    });
  });
});

/** An envelope whose `wsse:Security` carries only the given `wsu:Timestamp` children. */
function timestampEnvelope(children: string): string {
  return (
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soapenv:Header><wsse:Security ' +
    'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ' +
    'xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' +
    `<wsu:Timestamp>${children}</wsu:Timestamp>` +
    '</wsse:Security></soapenv:Header><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>'
  );
}
