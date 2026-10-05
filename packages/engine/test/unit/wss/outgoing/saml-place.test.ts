import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { createWssContext } from '../../../../src/wss/model.js';
import type { WssOutgoingConfig } from '../../../../src/wss/model.js';

const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';
const ASSERTION =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0"' +
  ' IssueInstant="2026-10-05T10:00:00Z"><saml2:Issuer>urn:test</saml2:Issuer></saml2:Assertion>';

function config(entries: WssOutgoingConfig['entries']): WssOutgoingConfig {
  return { id: 'w1', name: 'Federated', mustUnderstand: false, entries };
}

describe('placing a supplied SAML assertion', () => {
  it('appends it to wsse:Security in entry order, unchanged', async () => {
    const xml = await applyOutgoingWss(
      SOAP11,
      config([
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
        { kind: 'saml-token', source: 'xml', xml: ASSERTION, expandProperties: false },
      ]),
      createWssContext({ clock: () => new Date('2026-10-05T10:00:00Z'), uuid: () => 'u' }),
    );
    expect(xml.indexOf('wsu:Timestamp')).toBeLessThan(xml.indexOf('saml2:Assertion'));
    expect(xml).toContain('ID="_a1"');
    expect(xml).not.toMatch(/saml2:Assertion[^>]*wsu:Id/);
  });

  it('reads the file variant through ctx.projectFile', async () => {
    const xml = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', file: 'tokens/a.xml', expandProperties: false }]),
      createWssContext({ projectFile: (path) => Promise.resolve(path === 'tokens/a.xml' ? ASSERTION : '') }),
    );
    expect(xml).toContain('ID="_a1"');
  });

  it('refuses the file variant when the host lends no file reader', async () => {
    await expect(
      applyOutgoingWss(
        SOAP11,
        config([{ kind: 'saml-token', source: 'xml', file: 'tokens/a.xml', expandProperties: false }]),
        createWssContext(),
      ),
    ).rejects.toMatchObject({ code: 'saml-token-file-missing' });
  });

  it('expands ${…} only when the entry asks for it', async () => {
    const templated = ASSERTION.replace('urn:test', '${issuer}');
    const ctx = createWssContext({ expand: (text) => text.replace('${issuer}', 'urn:expanded') });
    const kept = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', xml: templated, expandProperties: false }]),
      ctx,
    );
    const expanded = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', xml: templated, expandProperties: true }]),
      ctx,
    );
    expect(kept).toContain('${issuer}');
    expect(expanded).toContain('urn:expanded');
  });

  it('refuses an entry that asks for expansion when the host lends no expander', async () => {
    const templated = ASSERTION.replace('urn:test', '${issuer}');
    await expect(
      applyOutgoingWss(
        SOAP11,
        config([{ kind: 'saml-token', source: 'xml', xml: templated, expandProperties: true }]),
        createWssContext(),
      ),
    ).rejects.toMatchObject({ code: 'unresolved-properties' });
  });

  it('refuses an issued-token entry with ws-trust-unavailable when no source is lent', async () => {
    await expect(
      applyOutgoingWss(
        SOAP11,
        config([
          {
            kind: 'issued-token',
            stsUrl: 'https://sts.test/trust',
            soapVersion: '1.2',
            trustVersion: '1.3',
            tokenType: '2.0',
            keyType: 'bearer',
            credential: { kind: 'username', username: 'alice' },
            requestedLifetimeSeconds: 0,
          },
        ]),
        createWssContext(),
      ),
    ).rejects.toMatchObject({ code: 'ws-trust-unavailable' });
  });

  it('builds a form assertion through the context clock and uuid', async () => {
    const xml = await applyOutgoingWss(
      SOAP11,
      config([
        {
          kind: 'saml-token',
          source: 'form',
          version: '2.0',
          issuer: 'urn:test',
          subject: 'alice',
          confirmation: 'bearer',
          lifetimeSeconds: 60,
          attributes: [],
        },
      ]),
      createWssContext({ clock: () => new Date('2026-10-05T10:00:00Z'), uuid: () => 'u1' }),
    );
    expect(xml).toContain('ID="_u1"');
    expect(xml).not.toMatch(/saml2:Assertion[^>]*wsu:Id/);
  });

  it('refuses a holder-of-key form assertion that names no proof keystore', async () => {
    await expect(
      applyOutgoingWss(
        SOAP11,
        config([
          {
            kind: 'saml-token',
            source: 'form',
            version: '2.0',
            issuer: 'urn:test',
            subject: 'alice',
            confirmation: 'holder-of-key',
            lifetimeSeconds: 60,
            attributes: [],
          },
        ]),
        createWssContext(),
      ),
    ).rejects.toMatchObject({ code: 'wss-proof-key-missing' });
  });
});

describe('placing a signed form assertion', () => {
  const ca = generateTestCa();
  const signer = generateSigningCert(ca);
  const encryptedKey = createPrivateKey(signer.keyPem).export({
    type: 'pkcs8',
    format: 'pem',
    cipher: 'aes-256-cbc',
    passphrase: 'pw',
  }) as string;
  const keystore = {
    type: 'pem',
    aliases: [{ alias: 'me', certPem: signer.certPem, keyPem: encryptedKey, chainPem: [], hasPrivateKey: true }],
  } as unknown as Keystore;
  const signed = {
    kind: 'saml-token',
    source: 'form',
    version: '2.0',
    issuer: 'urn:test',
    subject: 'alice',
    confirmation: 'bearer',
    lifetimeSeconds: 60,
    attributes: [],
    sign: { keystoreRef: 'issuer', keyPasswordRef: 'kp', signatureAlgorithm: 'rsa-sha256' },
  } as const;

  it('resolves the keystore and gets the key password through ctx.secrets', async () => {
    const asked: string[] = [];
    const xml = await applyOutgoingWss(
      SOAP11,
      config([signed]),
      createWssContext({
        keystores: (ref) => Promise.resolve(ref === 'issuer' ? keystore : undefined),
        secrets: (ref) => {
          asked.push(ref);
          return Promise.resolve(ref === 'kp' ? 'pw' : undefined);
        },
        uuid: () => 'u1',
      }),
    );
    expect(asked).toEqual(['kp']);
    expect(xml).toContain('<ds:SignatureValue>');
  });

  it('refuses wss-keystore-missing when the issuer keystore is not available', async () => {
    await expect(applyOutgoingWss(SOAP11, config([signed]), createWssContext())).rejects.toMatchObject({
      code: 'wss-keystore-missing',
    });
  });
});
