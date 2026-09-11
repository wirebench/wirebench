/**
 * `processIncomingWss`'s contract: it reports, it never throws, and it never lets a failure in
 * one step be mistaken for a failure in another.
 */

import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { createWssContext, DEFAULT_WSS_SIGNATURE_PARTS } from '../../../../src/wss/model.js';
import { processIncomingWss } from '../../../../src/wss/incoming/index.js';
import { loadKeystore } from '../../../../src/wss/keystore/index.js';
import type { WssIncomingConfig, WssPart } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';

const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

const ca = generateTestCa();
const signer = generateSigningCert(ca);
/** Two certificates and no key, so `selectAlias` cannot pick one on its own. */
const ambiguous = loadKeystore(Buffer.from([signer.certPem, ca.certPem].join('\n'), 'utf-8'), { type: 'pem' });

/**
 * An envelope that *looks* encrypted — enough for the no-op guard to let it through — but that
 * no key can open, so the decrypt step fails for a reason other than the key itself.
 */
const ENCRYPTED =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"/></soapenv:Body>' +
  '</soapenv:Envelope>';

const signerStore = loadKeystore(Buffer.from([signer.certPem, signer.keyPem].join('\n'), 'utf-8'), { type: 'pem' });
const truststore = loadKeystore(Buffer.from(signer.certPem, 'utf-8'), { type: 'pem' });

/** {@link ENVELOPE} signed by {@link signer} over `parts`, with a Timestamp. */
async function signedEnvelope(parts: readonly WssPart[] = DEFAULT_WSS_SIGNATURE_PARTS): Promise<string> {
  return await applyOutgoingWss(
    ENVELOPE,
    {
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
          parts: parts.map((part) => ({ ...part })),
        },
      ],
    },
    createWssContext({ keystores: () => Promise.resolve(signerStore) }),
  );
}

/** Overrides that may explicitly clear the optional refs, which `Partial` alone cannot express. */
type ConfigOverrides = Partial<Omit<WssIncomingConfig, 'decryptKeystoreRef' | 'decryptAlias'>> & {
  decryptKeystoreRef?: string | undefined;
  decryptAlias?: string | undefined;
};

function config(overrides?: ConfigOverrides): WssIncomingConfig {
  const merged = {
    id: 'in',
    name: 'In',
    decryptKeystoreRef: undefined as string | undefined,
    decryptAlias: undefined as string | undefined,
    requireSignature: false,
    requireTimestamp: false,
    timestampSkewSeconds: 300,
    verifyChain: true,
    ...overrides,
  };
  const { decryptKeystoreRef, decryptAlias, ...rest } = merged;
  return {
    ...rest,
    ...(decryptKeystoreRef !== undefined ? { decryptKeystoreRef } : {}),
    ...(decryptAlias !== undefined ? { decryptAlias } : {}),
  };
}

describe('processIncomingWss', () => {
  it('reports nothing for an unsecured response', async () => {
    const result = await processIncomingWss(ENVELOPE, config(), createWssContext());
    expect(result).toEqual({ actions: [], errors: [] });
  });

  it('reports a decryption keystore the project no longer has', async () => {
    const result = await processIncomingWss(
      ENVELOPE,
      config({ decryptKeystoreRef: 'gone' }),
      createWssContext({ keystores: () => Promise.resolve(undefined) }),
    );
    expect(result.actions[0]).toMatchObject({ kind: 'decrypt', ok: false });
    expect(result.errors).toEqual(['The decryption keystore is not available.']);
  });

  it('reports an alias that cannot be resolved rather than throwing', async () => {
    const result = await processIncomingWss(
      ENCRYPTED,
      config({ decryptKeystoreRef: 'k' }),
      createWssContext({ keystores: () => Promise.resolve(ambiguous) }),
    );
    expect(result.actions[0]).toMatchObject({ kind: 'decrypt', ok: false });
    expect(result.actions[1]).toMatchObject({ kind: 'signature', ok: false });
  });

  it('reports a message no key in the keystore can open', async () => {
    const keystore = loadKeystore(Buffer.from([signer.certPem, signer.keyPem].join('\n'), 'utf-8'), { type: 'pem' });
    const result = await processIncomingWss(
      ENCRYPTED,
      config({ decryptKeystoreRef: 'k' }),
      createWssContext({ keystores: () => Promise.resolve(keystore) }),
    );
    expect(result.actions.map((action) => action.kind)).toEqual(['decrypt', 'signature']);
    expect(result.errors).toHaveLength(1);
  });

  it('does not touch an unsecured response even with a usable decryption key', async () => {
    const keystore = loadKeystore(Buffer.from([signer.certPem, signer.keyPem].join('\n'), 'utf-8'), { type: 'pem' });
    const result = await processIncomingWss(
      ENVELOPE,
      config({ decryptKeystoreRef: 'k', decryptAlias: keystore.aliases[0]?.alias }),
      createWssContext({ keystores: () => Promise.resolve(keystore) }),
    );
    expect(result).toEqual({ actions: [], errors: [] });
  });

  it('reports a rejecting keystore resolver on the decrypt step rather than throwing', async () => {
    const result = await processIncomingWss(
      ENCRYPTED,
      config({ decryptKeystoreRef: 'k' }),
      createWssContext({ keystores: () => Promise.reject(new Error('keystore registry is gone')) }),
    );
    expect(result.actions[0]).toMatchObject({ kind: 'decrypt', ok: false });
    expect(result.actions[1]).toMatchObject({ kind: 'signature', ok: false });
    expect(result.errors[0]).toContain('keystore registry is gone');
  });

  it('reports a rejecting keystore resolver on the truststore rather than throwing', async () => {
    const xml = await signedEnvelope();
    const result = await processIncomingWss(
      xml,
      config({ signatureKeystoreRef: 'trust' }),
      createWssContext({ keystores: () => Promise.reject(new Error('truststore registry is gone')) }),
    );
    const signature = result.actions.find((action) => action.kind === 'signature');
    expect(signature).toMatchObject({ ok: false, trusted: false });
    expect(result.errors.some((error) => error.includes('truststore'))).toBe(true);
  });

  it('reports a malformed SignedInfo as a failed action rather than throwing', async () => {
    const xml = (await signedEnvelope()).replace(/<ds:SignedInfo[\s\S]*?<\/ds:SignedInfo>/, '<ds:SignedInfo/>');
    const result = await processIncomingWss(xml, config(), createWssContext());
    expect(result.actions.some((action) => action.kind === 'signature' && !action.ok)).toBe(true);
  });

  it('requires a valid, trusted signature over the Body', async () => {
    // Signed, but only over the Timestamp: `requireSignature` is about the Body.
    const xml = await signedEnvelope([{ name: 'Timestamp', namespace: WSU_NS, encode: 'Content' }]);
    const result = await processIncomingWss(
      xml,
      config({ requireSignature: true, signatureKeystoreRef: 'trust' }),
      createWssContext({ keystores: () => Promise.resolve(truststore) }),
    );
    const failed = result.actions.filter((action) => action.kind === 'signature' && !action.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain('Body');
  });

  it('carries the covered part names on a signature action', async () => {
    const result = await processIncomingWss(
      await signedEnvelope(),
      config({ signatureKeystoreRef: 'trust' }),
      createWssContext({ keystores: () => Promise.resolve(truststore) }),
    );
    const signature = result.actions.find((action) => action.kind === 'signature');
    expect(signature?.coversBody).toBe(true);
    expect(signature?.references).toEqual(['Body', 'Timestamp']);
  });

  it('reports both requirements at once', async () => {
    const result = await processIncomingWss(
      ENVELOPE,
      config({ requireSignature: true, requireTimestamp: true }),
      createWssContext(),
    );
    expect(result.actions.map((action) => action.kind)).toEqual(['signature', 'timestamp']);
    expect(result.errors).toHaveLength(2);
  });
});
