/**
 * Resolving a signer out of a `ds:KeyInfo` — every X.509 token profile form — and judging the
 * `wsu:Timestamp`. The signatures here are made by the real outgoing builder, so each key
 * identifier form is exercised exactly as it goes on the wire.
 */

import { createHash, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ExclusiveCanonicalization } from 'xml-crypto';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { loadKeystore } from '../../../../src/keystore/index.js';
import { createWssContext, DEFAULT_WSS_SIGNATURE_PARTS } from '../../../../src/wss/model.js';
import { verifyIncoming } from '../../../../src/wss/incoming/verify.js';
import { decryptIncoming } from '../../../../src/wss/incoming/decrypt.js';
import { parseXml } from '../../../../src/xml/parse.js';
import { serializeXml } from '../../../../src/xml/serialize.js';
import { NS } from '../../../../src/xml/namespaces.js';
import { certificateBase64 } from '../../../../src/wss/key-identifiers.js';
import type { Element } from '@xmldom/xmldom';
import type { Keystore } from '../../../../src/keystore/model.js';
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

/** A fixed "now" for the skew arithmetic. */
const FIXED_NOW = new Date('2026-10-07T10:00:00Z');

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
    expect(result.signatures[0]?.error).toMatch(
      /^KeyInfo names the signer by ThumbprintSHA1 [A-Za-z0-9+/]+=*, and no truststore is configured to look it up in\.$/,
    );
  });

  it('names the token a KeyInfo reference points at when no element carries it', async () => {
    const xml = (await sign('BinarySecurityToken')).replace(
      /(<wsse:BinarySecurityToken[^>]*wsu:Id=")X509-/,
      '$1Moved-',
    );
    const error = verifyIncoming(xml, { ...options, truststore }).signatures[0]?.error;
    expect(error).toMatch(/^KeyInfo refers to token #X509-[\w-]+, but no element in the message carries that id\.$/);
  });

  it('names the issuer and serial no truststore certificate matches', async () => {
    const xml = await sign('IssuerSerial');
    const other = keystoreOf(generateUntrustedCert().certPem);
    const error = verifyIncoming(xml, { ...options, truststore: other }).signatures[0]?.error;
    expect(error).toMatch(
      /^KeyInfo names the signer by issuer ".+" and serial \d+, and no truststore certificate matches\.$/,
    );
  });

  it('says when a signature carries no KeyInfo, or a form it cannot resolve', async () => {
    const signed = await sign('BinarySecurityToken');
    const bare = signed.replace(/<ds:KeyInfo>[\s\S]*?<\/ds:KeyInfo>/, '');
    expect(verifyIncoming(bare, { ...options, truststore }).signatures[0]?.error).toBe(
      'The signature carries no ds:KeyInfo, so its signer cannot be found.',
    );
    const named = signed.replace(
      /<ds:KeyInfo>[\s\S]*?<\/ds:KeyInfo>/,
      '<ds:KeyInfo><ds:KeyName>k</ds:KeyName></ds:KeyInfo>',
    );
    expect(verifyIncoming(named, { ...options, truststore }).signatures[0]?.error).toBe(
      'KeyInfo uses a form this build cannot resolve: KeyName.',
    );
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

  it('rejects a Timestamp created in the future beyond the skew, saying by how much', () => {
    const xml = timestampEnvelope('<wsu:Created>2026-10-07T10:01:35Z</wsu:Created>');
    const result = verifyIncoming(xml, { ...options, clock: () => FIXED_NOW, skewSeconds: 30 });
    expect(result.timestamp).toMatchObject({
      fresh: false,
      skewSeconds: -95,
      toleranceSeconds: 30,
      error: "Created 95 s ahead of this machine's clock; 30 s of clock skew is tolerated.",
    });
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

  it('rejects an expired Timestamp, saying how long ago it expired', () => {
    const xml = timestampEnvelope(
      '<wsu:Created>2026-10-07T09:55:00Z</wsu:Created><wsu:Expires>2026-10-07T09:59:20Z</wsu:Expires>',
    );
    expect(verifyIncoming(xml, { ...options, clock: () => FIXED_NOW, skewSeconds: 30 }).timestamp).toMatchObject({
      fresh: false,
      skewSeconds: 300,
      toleranceSeconds: 30,
      error: 'Expired 40 s ago (Expires 2026-10-07T09:59:20Z); 30 s of clock skew is tolerated.',
    });
  });

  it('rejects a stale Timestamp with no Expires, saying its age', () => {
    const xml = timestampEnvelope('<wsu:Created>2026-10-07T09:53:20Z</wsu:Created>');
    expect(verifyIncoming(xml, { ...options, clock: () => FIXED_NOW, skewSeconds: 300 }).timestamp).toMatchObject({
      fresh: false,
      skewSeconds: 400,
      error: 'Created 400 s ago and carries no Expires; 300 s of clock skew is tolerated.',
    });
  });

  it('measures the skew of a fresh Timestamp too', () => {
    const xml = timestampEnvelope('<wsu:Created>2026-10-07T09:59:57Z</wsu:Created>');
    expect(verifyIncoming(xml, { ...options, clock: () => FIXED_NOW }).timestamp).toMatchObject({
      fresh: true,
      skewSeconds: 3,
      toleranceSeconds: 300,
    });
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

  it('verifies both signatures when the second covers the wsse:Security header with an enveloped-signature transform', async () => {
    const first = await sign('BinarySecurityToken');
    const doc = parseXml(first, { location: 'envelope' });
    const root = doc.documentElement;
    if (root === null) {
      throw new Error('expected a parsed envelope');
    }
    const security = findByNs(root, NS.WSSE, 'Security');
    if (security === undefined) {
      throw new Error('expected a wsse:Security header');
    }
    security.setAttributeNS(NS.WSU, 'wsu:Id', 'Sec-1');

    // A second signature, whose only reference is the wsse:Security header itself via the
    // enveloped-signature transform — the real-world shape of a second signature that also
    // covers the header it lives in (and, with it, the first signature already sitting there).
    //
    // Built directly against xml-crypto's canonicalization (rather than through `SignedXml`'s
    // own `computeSignature`, whose enveloped-signature transform strips "the first ds:Signature
    // child" it finds when it does not yet know its own identity — the first signature already
    // present here, not itself) so the digest is computed exactly as `verifyIncoming`'s own
    // `checkSignature` will recompute it: over the Security header with the first signature
    // present and the second (not yet existing at signing time) absent.
    const digestValue = digestOf(security);
    const signedInfoXml =
      '<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">' +
      '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>' +
      '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>' +
      '<ds:Reference URI="#Sec-1"><ds:Transforms>' +
      '<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>' +
      '<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>' +
      '</ds:Transforms>' +
      '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>' +
      `<ds:DigestValue>${digestValue}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
    const signedInfoElement = parseXml(signedInfoXml, { location: 'signed-info' }).documentElement;
    if (signedInfoElement === null) {
      throw new Error('expected a parsed SignedInfo');
    }
    const canonicalSignedInfo = new ExclusiveCanonicalization().process(signedInfoElement, {});
    const signatureValue = createSign('RSA-SHA256').update(canonicalSignedInfo).sign(signer.keyPem, 'base64');
    const certificateBody = certificateBase64(signer.certPem);
    const signatureXml =
      '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">' +
      signedInfoXml +
      `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
      `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificateBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
      '</ds:Signature>';
    const signatureElement = parseXml(signatureXml, { location: 'signature' }).documentElement;
    if (signatureElement === null) {
      throw new Error('expected a parsed Signature');
    }
    security.appendChild(doc.importNode(signatureElement, true));

    const result = verifyIncoming(serializeXml(doc), { ...options, truststore });
    expect(result.signatures).toHaveLength(2);
    expect(result.signatures[0]).toMatchObject({ ok: true, trusted: true });
    expect(result.signatures[1]).toMatchObject({ ok: true, trusted: true, references: ['Sec-1'] });
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

/** The `DigestValue` an exc-c14n `ds:Reference` to `element` (as it stands right now) would carry. */
function digestOf(element: Element): string {
  const canonical = new ExclusiveCanonicalization().process(element.cloneNode(true) as Element, {});
  return createHash('sha256').update(canonical, 'utf-8').digest('base64');
}

/** The first descendant-or-self of `root` in `namespace` with local name `localName`. */
function findByNs(root: Element, namespace: string, localName: string): Element | undefined {
  if (root.namespaceURI === namespace && root.localName === localName) {
    return root;
  }
  for (let node = root.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType !== 1) {
      continue;
    }
    const found = findByNs(node as Element, namespace, localName);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

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
