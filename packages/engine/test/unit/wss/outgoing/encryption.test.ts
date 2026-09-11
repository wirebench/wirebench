import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { decryptEnvelope } from '../../../../src/wss/outgoing/encryption.js';
import { verifySignature } from '../../../../src/wss/outgoing/signature.js';
import { createWssContext } from '../../../../src/wss/model.js';
import { WSS_TOKEN_TYPES } from '../../../../src/wss/key-identifiers.js';
import { NS } from '../../../../src/xml/namespaces.js';
import { WssError } from '../../../../src/errors.js';
import { generateClientCert, generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore, KeystoreAlias } from '../../../../src/wss/keystore/model.js';
import type {
  WssEncryptionEntry,
  WssEntry,
  WssKeyIdentifierType,
  WssKeyTransportAlgorithm,
  WssOutgoingConfig,
  WssPart,
  WssSignatureEntry,
  WssSymmetricAlgorithm,
} from '../../../../src/wss/model.js';

const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><tns:Echo xmlns:tns="urn:test"><tns:Text>hello</tns:Text></tns:Echo></soapenv:Body>' +
  '</soapenv:Envelope>';

const ca = generateTestCa();
const recipient = generateSigningCert(ca);
// A different key pair entirely (and, deliberately, one without a Subject Key Identifier):
// nothing it holds can open an envelope encrypted to `recipient`.
const stranger = generateClientCert(ca);

/** A one-alias keystore around a PEM pair, the shape `WssContext.keystores` hands back. */
function keystoreOf(cert: { certPem: string; keyPem: string }, alias = 'recipient'): Keystore {
  const entry: KeystoreAlias = {
    alias,
    certPem: cert.certPem,
    keyPem: cert.keyPem,
    chainPem: [ca.certPem],
    subject: 'CN=recipient',
    issuer: 'CN=ca',
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z',
    serial: '01',
    fingerprintSha256: 'AA:BB',
    hasPrivateKey: true,
  };
  return { type: 'pem', aliases: [entry] };
}

const recipientKeystore = keystoreOf(recipient);
const strangerKeystore = keystoreOf(stranger, 'stranger');

/** The alias `decryptEnvelope` opens the envelope with. */
function aliasOf(keystore: Keystore): KeystoreAlias {
  const alias = keystore.aliases[0];
  if (alias === undefined) {
    throw new Error('the test keystore has no alias');
  }
  return alias;
}

let uuidCounter = 0;
let nonceCounter = 0;

function ctxFor(keystore: Keystore) {
  uuidCounter = 0;
  nonceCounter = 0;
  return createWssContext({
    keystores: () => Promise.resolve(keystore),
    clock: () => new Date('2026-09-11T10:00:00.000Z'),
    uuid: () => `u${++uuidCounter}`,
    // Deterministic but distinct per call, so a golden structure is stable while the IV of two
    // parts encrypted under the same key still differs.
    nonce: (bytes) => Uint8Array.from({ length: bytes }, (_value, index) => (index + ++nonceCounter) % 251),
  });
}

const BODY_CONTENT: WssPart = { name: 'Body', namespace: NS.SOAP11_ENV, encode: 'Content' };
const BODY_ELEMENT: WssPart = { name: 'Body', namespace: NS.SOAP11_ENV, encode: 'Element' };
const ECHO_PART: WssPart = { name: 'Echo', namespace: 'urn:test', encode: 'Element' };

/** Two sibling children, so a two-part entry encrypts two blocks that do not nest. */
const TWO_PART_SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><tns:Echo xmlns:tns="urn:test"><tns:Text>hello</tns:Text></tns:Echo>' +
  '<tns:Note xmlns:tns="urn:test">aside</tns:Note></soapenv:Body>' +
  '</soapenv:Envelope>';
const NOTE_PART: WssPart = { name: 'Note', namespace: 'urn:test', encode: 'Content' };

function encryptionEntry(overrides: Partial<WssEncryptionEntry> = {}): WssEncryptionEntry {
  return {
    kind: 'encryption',
    keystoreRef: 'ks-1',
    keyIdentifierType: 'BinarySecurityToken',
    symmetricAlgorithm: 'aes256-gcm',
    keyTransportAlgorithm: 'rsa-oaep',
    embedKey: false,
    encryptSymmetricKey: true,
    parts: [BODY_CONTENT],
    ...overrides,
  };
}

const SIGNATURE_ENTRY: WssSignatureEntry = {
  kind: 'signature',
  keystoreRef: 'ks-1',
  keyIdentifierType: 'BinarySecurityToken',
  signatureAlgorithm: 'rsa-sha256',
  digestAlgorithm: 'sha256',
  canonicalization: 'exc-c14n',
  useSingleCertificate: true,
  parts: [BODY_CONTENT],
};

function configOf(entries: readonly WssEntry[]): WssOutgoingConfig {
  return { id: 'wss-1', name: 'Outgoing', mustUnderstand: false, entries };
}

/** Applies `entries` to the standard envelope against the recipient keystore. */
function apply(entries: readonly WssEntry[], keystore: Keystore = recipientKeystore): Promise<string> {
  return applyOutgoingWss(SOAP11, configOf(entries), ctxFor(keystore));
}

const SYMMETRIC: readonly WssSymmetricAlgorithm[] = ['aes128-cbc', 'aes256-cbc', 'aes128-gcm', 'aes256-gcm'];
const TRANSPORT: readonly WssKeyTransportAlgorithm[] = ['rsa-oaep', 'rsa-1_5'];

describe('encryptEnvelope', () => {
  it('replaces the Body content with an EncryptedData and puts the EncryptedKey in the header', async () => {
    const xml = await apply([encryptionEntry()]);

    expect(xml).not.toContain('hello');
    expect(xml).toContain('<xenc:EncryptedData');
    expect(xml).toContain(`Type="${NS.XENC}Content"`);
    expect(xml).toContain(`Algorithm="http://www.w3.org/2009/xmlenc11#aes256-gcm"`);
    expect(xml).toContain('<xenc:EncryptedKey');
    expect(xml).toContain(`Algorithm="${NS.XENC}rsa-oaep-mgf1p"`);
    expect(xml).toContain(`<ds:DigestMethod Algorithm="${NS.DS}sha1"`);
    expect(xml).toContain('<xenc:DataReference URI="#ED-');
    // The Body element itself survives Content encryption, so a later signature can still
    // reference it by id.
    expect(xml).toContain('<soapenv:Body>');
  });

  for (const symmetricAlgorithm of SYMMETRIC) {
    for (const keyTransportAlgorithm of TRANSPORT) {
      it(`round-trips ${symmetricAlgorithm} with ${keyTransportAlgorithm}`, async () => {
        const xml = await apply([encryptionEntry({ symmetricAlgorithm, keyTransportAlgorithm })]);
        const result = decryptEnvelope(xml, {
          keystore: recipientKeystore,
          alias: aliasOf(recipientKeystore),
        });

        expect(result.decrypted).toEqual(['<tns:Echo xmlns:tns="urn:test"><tns:Text>hello</tns:Text></tns:Echo>']);
        expect(result.xml).toContain('<tns:Text>hello</tns:Text>');
        expect(result.xml).not.toContain('xenc:EncryptedData');
        // The consumed EncryptedKey is removed from the header.
        expect(result.xml).not.toContain('xenc:EncryptedKey');
      });
    }
  }

  it('encrypts a whole element and restores it on decryption', async () => {
    const xml = await apply([encryptionEntry({ parts: [ECHO_PART] })]);

    expect(xml).toContain(`Type="${NS.XENC}Element"`);
    expect(xml).not.toContain('tns:Echo');

    const result = decryptEnvelope(xml, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) });
    expect(result.xml).toContain('<tns:Echo xmlns:tns="urn:test"><tns:Text>hello</tns:Text></tns:Echo>');
  });

  it('encrypts the whole Body element when the part says Element', async () => {
    const xml = await apply([encryptionEntry({ parts: [BODY_ELEMENT] })]);

    expect(xml).toContain(`Type="${NS.XENC}Element"`);
    expect(xml).not.toContain('<soapenv:Body>');

    const result = decryptEnvelope(xml, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) });
    // Exclusive c14n makes the plaintext self-contained, so the restored Body redeclares the
    // envelope prefix it uses — the same bytes, a slightly different (equivalent) serialization.
    expect(result.xml).toContain('<tns:Echo xmlns:tns="urn:test"><tns:Text>hello</tns:Text></tns:Echo>');
  });

  it('encrypts two parts under one EncryptedKey with one DataReference each', async () => {
    const xml = await applyOutgoingWss(
      TWO_PART_SOAP11,
      configOf([encryptionEntry({ parts: [ECHO_PART, NOTE_PART] })]),
      ctxFor(recipientKeystore),
    );

    expect(xml.match(/<xenc:EncryptedKey/g)).toHaveLength(1);
    expect(xml.match(/<xenc:DataReference/g)).toHaveLength(2);

    const result = decryptEnvelope(xml, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) });
    expect(result.decrypted).toHaveLength(2);
    expect(result.xml).toContain('hello');
    expect(result.xml).toContain('aside');
  });

  it.each<WssKeyIdentifierType>([
    'BinarySecurityToken',
    'IssuerSerial',
    'SubjectKeyIdentifier',
    'X509KeyIdentifier',
    'Thumbprint',
  ])('references the recipient certificate as %s and still decrypts', async (keyIdentifierType) => {
    const xml = await apply([encryptionEntry({ keyIdentifierType })]);
    const result = decryptEnvelope(xml, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) });
    expect(result.xml).toContain('hello');
  });

  it('embeds a BinarySecurityToken the EncryptedKey references', async () => {
    const xml = await apply([encryptionEntry({ embedKey: true })]);

    expect(xml).toContain('<wsse:BinarySecurityToken');
    expect(xml).toContain(`ValueType="${WSS_TOKEN_TYPES.X509V3}"`);
    const tokenId = /wsu:Id="(X509-[^"]+)"/.exec(xml)?.[1];
    expect(tokenId).toBeDefined();
    expect(xml).toContain(`<wsse:Reference URI="#${String(tokenId)}"`);
  });

  it('names the issuer and serial for IssuerSerial', async () => {
    const xml = await apply([encryptionEntry({ keyIdentifierType: 'IssuerSerial' })]);

    expect(xml).toContain('<ds:X509IssuerSerial>');
    expect(xml).toContain('<ds:X509IssuerName>');
    expect(xml).toContain('<ds:X509SerialNumber>');
    expect(xml).not.toContain('BinarySecurityToken');
  });

  it('carries a ds:KeyName instead of an EncryptedKey when the symmetric key is shared out of band', async () => {
    const xml = await apply([encryptionEntry({ encryptSymmetricKey: false })]);

    expect(xml).not.toContain('xenc:EncryptedKey');
    expect(xml).toContain('<ds:KeyName>recipient</ds:KeyName>');
    expect(() => decryptEnvelope(xml, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) })).toThrowError(
      expect.objectContaining({ code: 'wss-decrypt-failed' }),
    );
  });

  it('rejects an entry naming a part the message does not have', async () => {
    await expect(
      apply([encryptionEntry({ parts: [{ name: 'Nope', namespace: 'urn:test', encode: 'Content' }] })]),
    ).rejects.toMatchObject({ code: 'wss-part-missing' });
  });

  it('leaves the envelope untouched when a part is missing', async () => {
    await expect(
      apply([encryptionEntry({ parts: [BODY_CONTENT, { name: 'Nope', namespace: 'urn:test', encode: 'Content' }] })]),
    ).rejects.toBeInstanceOf(WssError);
  });

  it('fails when the keystore the entry names is not available', async () => {
    const ctx = createWssContext({ keystores: () => Promise.resolve(undefined) });
    await expect(applyOutgoingWss(SOAP11, configOf([encryptionEntry()]), ctx)).rejects.toMatchObject({
      code: 'wss-keystore-missing',
    });
  });
});

describe('decryptEnvelope', () => {
  it('fails with wss-decrypt-failed for the wrong recipient key', async () => {
    const xml = await apply([encryptionEntry()]);

    expect(() => decryptEnvelope(xml, { keystore: strangerKeystore, alias: aliasOf(strangerKeystore) })).toThrowError(
      expect.objectContaining({ code: 'wss-decrypt-failed' }),
    );
  });

  it.each<WssSymmetricAlgorithm>(['aes256-gcm', 'aes256-cbc'])(
    'fails when the %s CipherValue has been tampered with',
    async (symmetricAlgorithm) => {
      const xml = await apply([encryptionEntry({ symmetricAlgorithm })]);
      const tampered = xml.replace(
        /(<xenc:EncryptedData[\s\S]*?<xenc:CipherValue>)([A-Za-z0-9+/=]+)(<\/xenc:CipherValue>)/,
        (_match, open: string, value: string, close: string) => {
          const flipped = value.slice(0, -8) + (value.slice(-8, -7) === 'A' ? 'B' : 'A') + value.slice(-7);
          return `${open}${flipped}${close}`;
        },
      );
      expect(tampered).not.toEqual(xml);

      expect(() =>
        decryptEnvelope(tampered, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) }),
      ).toThrowError(expect.objectContaining({ code: 'wss-decrypt-failed' }));
    },
  );

  it('rejects an unsupported content algorithm', async () => {
    const xml = await apply([encryptionEntry()]);
    const swapped = xml.replace('http://www.w3.org/2009/xmlenc11#aes256-gcm', 'urn:made-up');

    expect(() =>
      decryptEnvelope(swapped, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) }),
    ).toThrowError(expect.objectContaining({ code: 'wss-algorithm-unsupported' }));
  });

  it('rejects an unsupported key transport algorithm', async () => {
    const xml = await apply([encryptionEntry()]);
    const swapped = xml.replace(`${NS.XENC}rsa-oaep-mgf1p`, 'urn:made-up-transport');

    expect(() =>
      decryptEnvelope(swapped, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) }),
    ).toThrowError(expect.objectContaining({ code: 'wss-algorithm-unsupported' }));
  });

  it('rejects a document with nothing encrypted in it', () => {
    expect(() =>
      decryptEnvelope(SOAP11, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) }),
    ).toThrowError(expect.objectContaining({ code: 'wss-decrypt-failed' }));
  });

  it('rejects an alias with no private key', async () => {
    const xml = await apply([encryptionEntry()]);
    const alias = aliasOf(recipientKeystore);
    const { keyPem: dropped, ...withoutKey } = alias;
    expect(dropped).toBeDefined();

    expect(() =>
      decryptEnvelope(xml, { keystore: recipientKeystore, alias: { ...withoutKey, hasPrivateKey: false } }),
    ).toThrowError(expect.objectContaining({ code: 'wss-decryption-key-missing' }));
  });
});

describe('entry order', () => {
  it('sign-then-encrypt: the signature verifies once the Body is decrypted', async () => {
    const xml = await apply([SIGNATURE_ENTRY, encryptionEntry()]);

    expect(xml).toContain('ds:Signature');
    expect(xml).not.toContain('hello');
    // Entry order decides header order: the EncryptedKey lands after the Signature.
    expect(xml.indexOf('<ds:Signature')).toBeLessThan(xml.indexOf('<xenc:EncryptedKey'));

    const result = decryptEnvelope(xml, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) });
    expect(verifySignature(result.xml, { certPem: recipient.certPem })).toMatchObject({ ok: true });
  });

  it('encrypt-then-sign: the signature covers the ciphertext and verifies as sent', async () => {
    const xml = await apply([encryptionEntry(), SIGNATURE_ENTRY]);

    expect(xml.indexOf('<xenc:EncryptedKey')).toBeLessThan(xml.indexOf('<ds:Signature'));
    expect(verifySignature(xml, { certPem: recipient.certPem })).toMatchObject({ ok: true });

    const result = decryptEnvelope(xml, { keystore: recipientKeystore, alias: aliasOf(recipientKeystore) });
    expect(result.xml).toContain('<tns:Text>hello</tns:Text>');
  });
});
