/**
 * Incoming WS-Security against a server that really signs and encrypts: the `/wss/*` routes
 * secure their responses with the server's own key and the client's certificate, so everything
 * here is judged over bytes that actually crossed a socket.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { sendSoapRequest } from '../../../src/send.js';
import { loadKeystore } from '../../../src/wss/keystore/index.js';
import { createWssContext } from '../../../src/wss/model.js';
import type { Keystore } from '../../../src/wss/keystore/model.js';
import type { WssIncomingConfig } from '../../../src/wss/model.js';
import { generateClientCert, generateSigningCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestSoapServer, type TestSoapServer } from '../../helpers/test-soap-server.js';

const servers: TestSoapServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
  '<soapenv:Body><tem:Add><tem:intA>2</tem:intA><tem:intB>3</tem:intB></tem:Add></soapenv:Body></soapenv:Envelope>';

const ca = generateTestCa();
/** The server's WS-Security identity — what the client's truststore is meant to accept. */
const serverSigner = generateSigningCert(ca);
/** The client's own identity: responses are encrypted to this certificate. */
const client = generateClientCert(ca);

function keystoreOf(...pems: readonly string[]): Keystore {
  return loadKeystore(Buffer.from(pems.join('\n'), 'utf-8'), { type: 'pem' });
}

/** A truststore holding the server's signing certificate verbatim. */
const truststore = keystoreOf(serverSigner.certPem);
/** A truststore holding only the CA, so trust has to be established by chaining. */
const caTruststore = keystoreOf(ca.certPem);
/** The client's decryption keystore: its certificate plus its private key. */
const clientKeystore = keystoreOf(client.certPem, client.keyPem);
/** A keystore holding a key that cannot open anything the server sent. */
const wrongKeystore = keystoreOf(serverSigner.certPem, serverSigner.keyPem);

/** Overrides that may explicitly clear the optional refs, which `Partial` alone cannot express. */
type ConfigOverrides = Partial<Omit<WssIncomingConfig, 'decryptKeystoreRef' | 'decryptAlias'>> & {
  decryptKeystoreRef?: string | undefined;
  decryptAlias?: string | undefined;
};

function config(overrides?: ConfigOverrides): WssIncomingConfig {
  const merged = {
    id: 'in',
    name: 'Incoming',
    decryptKeystoreRef: 'decrypt' as string | undefined,
    decryptAlias: undefined as string | undefined,
    signatureKeystoreRef: 'trust',
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

function ctxWith(options?: { trust?: Keystore; decrypt?: Keystore; clock?: () => Date }) {
  return createWssContext({
    keystores: (ref) =>
      Promise.resolve(ref === 'trust' ? (options?.trust ?? truststore) : (options?.decrypt ?? clientKeystore)),
    ...(options?.clock !== undefined ? { clock: options.clock } : {}),
  });
}

async function send(path: string, incoming: WssIncomingConfig, ctx = ctxWith()) {
  const server = await startTestSoapServer({
    respondToCalculatorAdd: true,
    wss: { serverIdentity: serverSigner, clientCertPem: client.certPem },
  });
  servers.push(server);
  return await sendSoapRequest({
    endpoint: `${server.url}${path}`,
    envelopeXml: ENVELOPE,
    soapVersion: '1.1',
    wss: { incoming, ctx },
  });
}

describe('incoming WS-Security over a real response', () => {
  it('decrypts and verifies a signed, encrypted response', async () => {
    const exchange = await send('/wss/sign-encrypt', config());

    expect(exchange.wss?.incoming?.errors).toEqual([]);
    const actions = exchange.wss?.incoming?.actions ?? [];
    expect(actions.map((action) => action.kind)).toEqual(['decrypt', 'signature', 'timestamp']);
    expect(actions.every((action) => action.ok)).toBe(true);
    expect(actions[1]?.trusted).toBe(true);
    expect(actions[1]?.signerSubject).toContain('wirebench-signer');

    // The XML view shows plaintext …
    expect(exchange.response?.envelopeXml).toContain('AddResult');
    expect(exchange.response?.envelopeXml).toContain('5');
    // … while the bytes that arrived are still ciphertext.
    const raw = Buffer.from(exchange.http.body).toString('utf-8');
    expect(raw).toContain('xenc:EncryptedData');
    expect(raw).not.toContain('AddResult');
  });

  it('trusts a signer that chains to a CA in the truststore', async () => {
    const exchange = await send(
      '/wss/sign',
      config({ decryptKeystoreRef: undefined }),
      ctxWith({ trust: caTruststore }),
    );
    const signature = exchange.wss?.incoming?.actions.find((action) => action.kind === 'signature');
    expect(signature?.ok).toBe(true);
    expect(signature?.trusted).toBe(true);
  });

  it('does not trust a chaining signer when chain verification is off', async () => {
    const exchange = await send(
      '/wss/sign',
      config({ decryptKeystoreRef: undefined, verifyChain: false }),
      ctxWith({ trust: caTruststore }),
    );
    const signature = exchange.wss?.incoming?.actions.find((action) => action.kind === 'signature');
    expect(signature?.ok).toBe(false);
    expect(signature?.trusted).toBe(false);
  });

  it('flags a tampered response', async () => {
    const exchange = await send('/wss/tampered', config({ decryptKeystoreRef: undefined }));
    const signature = exchange.wss?.incoming?.actions.find((action) => action.kind === 'signature');
    expect(signature?.ok).toBe(false);
    // The certificate is still the server's, so the failure is the signature itself, not trust.
    expect(signature?.trusted).toBe(true);
    expect(exchange.wss?.incoming?.errors.length).toBeGreaterThan(0);
  });

  it('flags a signer that is not in the truststore', async () => {
    const exchange = await send('/wss/untrusted', config({ decryptKeystoreRef: undefined }));
    const signature = exchange.wss?.incoming?.actions.find((action) => action.kind === 'signature');
    expect(signature?.ok).toBe(false);
    expect(signature?.trusted).toBe(false);
    expect(signature?.detail).toContain('not trusted');
  });

  it('reports nothing for a plain response', async () => {
    const exchange = await send('/soap', config({ decryptKeystoreRef: undefined }));
    expect(exchange.wss?.incoming).toEqual({ actions: [], errors: [] });
    expect(exchange.response?.envelopeXml).toContain('AddResult');
  });

  it('fails the signature action when one is required and absent', async () => {
    const exchange = await send('/soap', config({ decryptKeystoreRef: undefined, requireSignature: true }));
    const actions = exchange.wss?.incoming?.actions ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'signature', ok: false });
  });

  it('fails the timestamp action when one is required and absent', async () => {
    const exchange = await send('/soap', config({ decryptKeystoreRef: undefined, requireTimestamp: true }));
    const actions = exchange.wss?.incoming?.actions ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'timestamp', ok: false });
  });

  it('fails the timestamp action for a response that has already expired', async () => {
    // An hour into the future, so the server's 300-second timestamp is long gone even after the
    // configured skew.
    const later = () => new Date(Date.now() + 60 * 60 * 1000);
    const exchange = await send('/wss/sign', config({ decryptKeystoreRef: undefined }), ctxWith({ clock: later }));
    const timestamp = exchange.wss?.incoming?.actions.find((action) => action.kind === 'timestamp');
    expect(timestamp?.ok).toBe(false);
    expect(timestamp?.created).toBeTruthy();
    expect(timestamp?.expires).toBeTruthy();
  });

  it('fails the decrypt action, and skips the signatures, with the wrong keystore', async () => {
    const exchange = await send('/wss/sign-encrypt', config(), ctxWith({ decrypt: wrongKeystore }));
    const actions = exchange.wss?.incoming?.actions ?? [];
    expect(actions.map((action) => action.kind)).toEqual(['decrypt', 'signature']);
    expect(actions[0]?.ok).toBe(false);
    expect(actions[1]?.detail).toContain('could not be decrypted');
    // The envelope is left exactly as it arrived: still ciphertext.
    expect(exchange.response?.envelopeXml).toContain('xenc:EncryptedData');
  });

  it('reports a missing truststore rather than silently trusting nothing', async () => {
    const ctx = createWssContext({ keystores: () => Promise.resolve(undefined) });
    const exchange = await send('/wss/sign', config({ decryptKeystoreRef: undefined }), ctx);
    expect(exchange.wss?.incoming?.errors).toContain('The signature truststore is not available.');
  });
});
