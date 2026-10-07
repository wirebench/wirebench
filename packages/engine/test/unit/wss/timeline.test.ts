/**
 * The timeline of a `wsse:Security` header (#57, SC-WD5): every step in header order, with what
 * each signed or encrypted — and nothing a user typed into a UsernameToken.
 */

import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../src/wss/apply.js';
import { loadKeystore } from '../../../src/keystore/index.js';
import { createWssContext, DEFAULT_WSS_SIGNATURE_PARTS } from '../../../src/wss/model.js';
import { describeSecurityHeader } from '../../../src/wss/timeline.js';
import { processIncomingWss } from '../../../src/wss/incoming/index.js';
import type { WssOutgoingConfig } from '../../../src/wss/model.js';
import { generateClientCert, generateSigningCert, generateTestCa } from '../../helpers/test-certs.js';

const SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const ENVELOPE = `<soapenv:Envelope xmlns:soapenv="${SOAP11}"><soapenv:Body><Ping>hello</Ping></soapenv:Body></soapenv:Envelope>`;

const ca = generateTestCa();
const signer = generateSigningCert(ca);
const recipient = generateClientCert(ca);
const keystores = (ref: string) =>
  Promise.resolve(
    loadKeystore(
      Buffer.from(
        ref === 'signer' ? `${signer.certPem}\n${signer.keyPem}` : `${recipient.certPem}\n${recipient.keyPem}`,
      ),
      { type: 'pem' },
    ),
  );

const SIGN_AND_ENCRYPT: WssOutgoingConfig = {
  id: 'o',
  name: 'O',
  mustUnderstand: true,
  entries: [
    { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
    {
      kind: 'signature',
      keystoreRef: 'signer',
      keyIdentifierType: 'BinarySecurityToken',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: DEFAULT_WSS_SIGNATURE_PARTS.map((part) => ({ ...part })),
    },
    {
      kind: 'encryption',
      keystoreRef: 'recipient',
      keyIdentifierType: 'BinarySecurityToken',
      symmetricAlgorithm: 'aes256-gcm',
      keyTransportAlgorithm: 'rsa-oaep',
      embedKey: true,
      encryptSymmetricKey: true,
      parts: [{ name: 'Body', namespace: SOAP11, encode: 'Content' }],
    },
  ],
};

const NO_INCOMING_CHECKS = {
  id: 'i',
  name: 'I',
  requireSignature: false,
  requireTimestamp: false,
  timestampSkewSeconds: 300,
  verifyChain: false,
} as const;

describe('describeSecurityHeader', () => {
  it('lists a sign-then-encrypt header in order, with what each step covers', async () => {
    const secured = await applyOutgoingWss(ENVELOPE, SIGN_AND_ENCRYPT, createWssContext({ keystores }));
    const steps = describeSecurityHeader(secured);
    expect(steps.map((step) => step.kind)).toEqual(['timestamp', 'token', 'signature', 'token', 'encryption']);
    expect(steps[0]?.summary).toMatch(/^Timestamp \(created \S+Z, expires \S+Z\)$/);
    expect(steps[1]?.summary).toMatch(/^X\.509 certificate \(.+\)$/);
    expect(steps[2]).toMatchObject({
      summary: 'Signed Body, Timestamp (rsa-sha256, exc-c14n)',
      covers: ['Body', 'Timestamp'],
    });
    expect(steps[4]).toMatchObject({ covers: ['Body (content)'] });
    expect(steps[4]?.summary).toMatch(/^Encrypted Body \(content\) \(aes256-gcm, key rsa-oaep/);
    expect(steps.every((step) => step.actor === undefined)).toBe(true);
  });

  it('names a UsernameToken by its password type only', () => {
    const xml =
      `<soapenv:Envelope xmlns:soapenv="${SOAP11}"><soapenv:Header>` +
      '<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      '<wsse:UsernameToken><wsse:Username>alice</wsse:Username>' +
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">x</wsse:Password>' +
      '</wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body/></soapenv:Envelope>';
    const steps = describeSecurityHeader(xml);
    expect(steps).toEqual([{ kind: 'username-token', summary: 'UsernameToken (PasswordDigest)' }]);
    expect(JSON.stringify(steps)).not.toContain('alice');
  });

  it('carries the actor a header is addressed to', () => {
    const xml =
      `<soapenv:Envelope xmlns:soapenv="${SOAP11}"><soapenv:Header>` +
      '<wsse:Security soapenv:actor="urn:gateway" ' +
      'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
      '<Custom/></wsse:Security></soapenv:Header><soapenv:Body/></soapenv:Envelope>';
    expect(describeSecurityHeader(xml)).toEqual([{ kind: 'other', summary: 'Custom', actor: 'urn:gateway' }]);
  });

  it('is empty for anything that is not a secured envelope', () => {
    expect(describeSecurityHeader('not xml')).toEqual([]);
    expect(describeSecurityHeader('<a/>')).toEqual([]);
    expect(describeSecurityHeader(ENVELOPE)).toEqual([]);
  });

  it('is part of the incoming result, read from the message as it arrived', async () => {
    const secured = await applyOutgoingWss(ENVELOPE, SIGN_AND_ENCRYPT, createWssContext({ keystores }));
    const result = await processIncomingWss(
      secured,
      { ...NO_INCOMING_CHECKS, decryptKeystoreRef: 'recipient' },
      createWssContext({ keystores }),
    );
    expect(result.decryptedXml).toBeDefined();
    expect(result.timeline?.map((step) => step.kind)).toEqual([
      'timestamp',
      'token',
      'signature',
      'token',
      'encryption',
    ]);
  });

  it('leaves the incoming result without a timeline when the response has no header', async () => {
    const result = await processIncomingWss(ENVELOPE, NO_INCOMING_CHECKS, createWssContext({ keystores }));
    expect(result.timeline).toBeUndefined();
  });
});
