import { describe, expect, it } from 'vitest';
import { soapRun } from '../../../src/soap/run.js';
import { projectWithWss } from '../../helpers/fixtures.js';

describe('secret needs of SAML entries', () => {
  it('lists the STS password and the form signing key password', () => {
    const { project, selected } = projectWithWss([
      {
        kind: 'issued-token',
        stsUrl: 'https://sts.test',
        soapVersion: '1.2',
        trustVersion: '1.3',
        tokenType: '2.0',
        keyType: 'public-key',
        proofKeystoreRef: 'ks-proof',
        credential: { kind: 'username', username: 'alice', passwordRef: 'sec_sts' },
        requestedLifetimeSeconds: 0,
        tlsKeystoreRef: 'ks-tls',
      },
      {
        kind: 'saml-token',
        source: 'form',
        version: '2.0',
        issuer: 'i',
        subject: 's',
        confirmation: 'bearer',
        lifetimeSeconds: 300,
        attributes: [],
        sign: { keystoreRef: 'ks-issuer', keyPasswordRef: 'sec_issuer_key', signatureAlgorithm: 'rsa-sha256' },
      },
    ]);
    const refs = soapRun.secretNeeds(selected, project).map((need) => need.ref);
    expect(refs).toEqual(expect.arrayContaining(['sec_sts', 'sec_issuer_key']));
  });

  it('lists the certificate credential key password', () => {
    const { project, selected } = projectWithWss([
      {
        kind: 'issued-token',
        stsUrl: 'https://sts.test',
        soapVersion: '1.2',
        trustVersion: '1.3',
        tokenType: '2.0',
        keyType: 'bearer',
        credential: { kind: 'certificate', keystoreRef: 'ks-proof', keyPasswordRef: 'sec_client_key' },
        requestedLifetimeSeconds: 0,
      },
    ]);
    expect(soapRun.secretNeeds(selected, project).map((need) => need.ref)).toContain('sec_client_key');
  });
});
