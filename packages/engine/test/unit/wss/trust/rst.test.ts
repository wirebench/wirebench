import { describe, expect, it } from 'vitest';
import { buildRst } from '../../../../src/wss/trust/rst.js';
import { createWssContext } from '../../../../src/wss/model.js';
import { generateSigningCert, generateTestCa } from '../../../helpers/test-certs.js';
import type { Keystore } from '../../../../src/keystore/model.js';
import type { WssIssuedTokenEntry } from '../../../../src/wss/model.js';

const ca = generateTestCa();
const client = generateSigningCert(ca);
const keystore = {
  type: 'pem',
  aliases: [{ alias: 'me', certPem: client.certPem, keyPem: client.keyPem, chainPem: [] }],
} as unknown as Keystore;

function ctx() {
  let n = 0;
  return createWssContext({
    clock: () => new Date('2026-10-05T10:00:00.000Z'),
    uuid: () => `u${String((n += 1))}`,
    nonce: () => new Uint8Array(16),
    secrets: (ref) => Promise.resolve(ref === 'sec_sts' ? 'hunter2' : undefined),
    keystores: () => Promise.resolve(keystore),
  });
}

function entry(overrides: Partial<WssIssuedTokenEntry> = {}): WssIssuedTokenEntry {
  return {
    kind: 'issued-token',
    stsUrl: 'https://sts.test/trust/13/usernamemixed',
    soapVersion: '1.2',
    trustVersion: '1.3',
    tokenType: '2.0',
    keyType: 'bearer',
    credential: { kind: 'username', username: 'alice', passwordRef: 'sec_sts' },
    requestedLifetimeSeconds: 0,
    ...overrides,
  };
}

const input = () => ({
  stsUrl: 'https://sts.test/trust/13/usernamemixed',
  appliesTo: 'https://service.test/',
  ctx: ctx(),
});

describe('buildRst', () => {
  it('WS-Trust 1.3, SOAP 1.2, username: WS-A headers, a timestamp, a text password and a bearer RST', async () => {
    const rst = await buildRst(entry(), input());
    expect(rst.action).toBe('http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue');
    expect(rst.contentType).toBe(
      'application/soap+xml; charset=utf-8; action="http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue"',
    );
    expect(rst.xml).toContain('<wsa:To');
    expect(rst.xml).toContain('#PasswordText">hunter2</wsse:Password>');
    expect(rst.xml).toContain('<wst:KeyType>http://docs.oasis-open.org/ws-sx/ws-trust/200512/Bearer</wst:KeyType>');
    expect(rst.xml).toContain('<wsa:Address>https://service.test/</wsa:Address>');
    expect(rst.xml).toMatchSnapshot();
  });

  it('WS-Trust 2005/02, SOAP 1.1: the draft namespace and action, text/xml', async () => {
    const rst = await buildRst(entry({ trustVersion: '2005-02', soapVersion: '1.1' }), input());
    expect(rst.action).toBe('http://schemas.xmlsoap.org/ws/2005/02/trust/RST/Issue');
    expect(rst.contentType).toBe('text/xml; charset=utf-8');
    expect(rst.xml).toContain('xmlns:wst="http://schemas.xmlsoap.org/ws/2005/02/trust"');
    expect(rst.xml).toMatchSnapshot();
  });

  it('certificate credential: a BinarySecurityToken and a signature, no username token', async () => {
    const rst = await buildRst(entry({ credential: { kind: 'certificate', keystoreRef: 'ks' } }), input());
    expect(rst.xml).toContain('<wsse:BinarySecurityToken');
    expect(rst.xml).toContain('<ds:Signature');
    expect(rst.xml).not.toContain('<wsse:UsernameToken');
  });

  it('public-key: UseKey carries the proof certificate', async () => {
    const rst = await buildRst(entry({ keyType: 'public-key' }), { ...input(), proofCertPem: client.certPem });
    expect(rst.xml).toContain('/PublicKey</wst:KeyType>');
    expect(rst.xml).toMatch(/<wst:UseKey><wsse:BinarySecurityToken[^>]*X509v3/);
  });

  it('Lifetime and Claims only when set', async () => {
    const plain = await buildRst(entry(), input());
    expect(plain.xml).not.toContain('<wst:Lifetime>');
    const rst = await buildRst(entry({ requestedLifetimeSeconds: 3600 }), {
      ...input(),
      claims: '<wst:Claims Dialect="urn:d"><c/></wst:Claims>',
    });
    expect(rst.xml).toContain('<wsu:Expires>2026-10-05T11:00:00.000Z</wsu:Expires>');
    expect(rst.xml).toContain('<wst:Claims Dialect="urn:d"><c/></wst:Claims>');
  });

  it('kerberos credential: the AP-REQ follows the Timestamp inside the one Security header', async () => {
    const rst = await buildRst(entry({ credential: { kind: 'kerberos', spn: 'HTTP@sts.test' } }), {
      ...input(),
      kerberosToken: new Uint8Array([1, 2, 3]),
    });
    expect(rst.xml.match(/<wsse:Security[ >]/g)).toHaveLength(1);
    expect(rst.xml).toMatch(
      /<\/wsu:Timestamp><wsse:BinarySecurityToken wsu:Id="Kerberos-u\d+" ValueType="[^"]*GSS_Kerberosv5_AP_REQ" EncodingType="[^"]*">AQID<\/wsse:BinarySecurityToken><\/wsse:Security>/,
    );
  });

  it('refuses a username credential over plain http', async () => {
    await expect(buildRst(entry(), { ...input(), stsUrl: 'http://sts.test/trust' })).rejects.toMatchObject({
      code: 'ws-trust-insecure-transport',
    });
  });
});
