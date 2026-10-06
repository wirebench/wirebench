import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { proofCertOf, requestIssuedToken } from '../../src/wss/trust/client.js';
import { createWssContext } from '../../src/wss/model.js';
import { startTestSts } from '../helpers/test-sts-server.js';
import { generateSigningCert, generateTestCa } from '../helpers/test-certs.js';
import type { TestSts } from '../helpers/test-sts-server.js';
import type { WssIssuedTokenEntry } from '../../src/wss/model.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/ws-trust/${name}`, import.meta.url)), 'utf8');

let sts: TestSts | undefined;
afterEach(async () => {
  await sts?.close();
  sts = undefined;
});

const ctx = createWssContext({ secrets: () => Promise.resolve('hunter2') });

function entry(stsUrl: string): WssIssuedTokenEntry {
  return {
    kind: 'issued-token',
    stsUrl,
    soapVersion: '1.2',
    trustVersion: '1.3',
    tokenType: '2.0',
    keyType: 'bearer',
    credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
    requestedLifetimeSeconds: 0,
  };
}

describe('requestIssuedToken', () => {
  it('posts the RST and returns the token with its lifetime and host', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    const seen: number[] = [];
    const token = await requestIssuedToken(
      entry(sts.url),
      { endpointUrl: 'https://service.test/', expand: (t) => t, tls: { ca: [sts.caPem] } },
      { ctx, onExchange: (exchange) => seen.push(exchange.status) },
    );
    expect(token.assertionId).toBe('_fixture-2.0');
    expect(token.stsHost).toBe('127.0.0.1');
    expect(token.expiresAt?.toISOString()).toBe('2026-10-05T11:00:00.000Z');
    expect(sts.requests[0]?.headers['content-type']).toContain(
      'action="http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue"',
    );
    expect(sts.requests[0]?.body).toContain('<wsa:Address>https://service.test/</wsa:Address>');
    expect(seen).toEqual([200]);
  });

  it('uses the entry AppliesTo, expanded, over the endpoint', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    await requestIssuedToken(
      { ...entry(sts.url), appliesTo: '${realm}' },
      {
        endpointUrl: 'https://service.test/',
        expand: (t) => t.replace('${realm}', 'urn:realm'),
        tls: { ca: [sts.caPem] },
      },
      { ctx },
    );
    expect(sts.requests[0]?.body).toContain('<wsa:Address>urn:realm</wsa:Address>');
  });

  it('refuses a redirect instead of following it, still reporting the exchange', async () => {
    sts = await startTestSts(() => ({ status: 302, body: '', headers: { location: 'https://elsewhere.test/' } }));
    const seen: number[] = [];
    await expect(
      requestIssuedToken(
        entry(sts.url),
        { endpointUrl: 'https://s/', expand: (t) => t, tls: { ca: [sts.caPem] } },
        { ctx, onExchange: (exchange) => seen.push(exchange.status) },
      ),
    ).rejects.toMatchObject({ code: 'ws-trust-sts-fault' });
    expect(seen).toEqual([302]);
  });

  it('passes a fault through as ws-trust-sts-fault, still reporting the exchange', async () => {
    sts = await startTestSts(() => ({ status: 500, body: fixture('fault-1.2.xml') }));
    const seen: number[] = [];
    await expect(
      requestIssuedToken(
        entry(sts.url),
        { endpointUrl: 'https://s/', expand: (t) => t, tls: { ca: [sts.caPem] } },
        { ctx, onExchange: (exchange) => seen.push(exchange.status) },
      ),
    ).rejects.toMatchObject({ code: 'ws-trust-sts-fault' });
    expect(seen).toEqual([500]);
  });

  it('refuses a Kerberos credential with kerberos-unavailable when no seam is lent', async () => {
    await expect(
      requestIssuedToken(
        { ...entry('https://sts.test/'), credential: { kind: 'kerberos', spn: 'HTTP@sts.test' } },
        { endpointUrl: 'https://s/', expand: (t) => t },
        { ctx },
      ),
    ).rejects.toMatchObject({ code: 'kerberos-unavailable' });
  });

  it('sends UseKey and returns proofCertPem for a public-key token', async () => {
    sts = await startTestSts(() => ({ status: 200, body: fixture('rstrc-1.3-saml2.xml') }));
    const cert = generateSigningCert(generateTestCa());
    const proofCtx = createWssContext({
      secrets: () => Promise.resolve('hunter2'),
      keystores: () =>
        Promise.resolve({
          type: 'pkcs12',
          aliases: [
            {
              alias: 'proof',
              certPem: cert.certPem,
              keyPem: cert.keyPem,
              chainPem: [],
              subject: 'CN=proof',
              issuer: 'CN=ca',
            },
          ],
        } as never),
    });
    const token = await requestIssuedToken(
      { ...entry(sts.url), keyType: 'public-key', proofKeystoreRef: 'ks' },
      { endpointUrl: 'https://s/', expand: (t) => t, tls: { ca: [sts.caPem] } },
      { ctx: proofCtx },
    );
    expect(token.proofCertPem).toBe(cert.certPem);
    expect(sts.requests[0]?.body).toContain('UseKey');
  });
});

describe('proofCertOf', () => {
  it('is undefined for bearer and refuses a public-key entry with no proof keystore', async () => {
    await expect(proofCertOf(entry('https://sts.test/'), ctx)).resolves.toBeUndefined();
    await expect(proofCertOf({ ...entry('https://sts.test/'), keyType: 'public-key' }, ctx)).rejects.toMatchObject({
      code: 'wss-proof-key-missing',
    });
  });
});
