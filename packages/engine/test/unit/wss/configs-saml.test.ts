import { describe, expect, it } from 'vitest';
import { toWssOutgoingConfig, toWssOutgoingRef } from '../../../src/wss/configs.js';
import { wssOutgoingFileSchema } from '../../../src/project/schema.js';
import type { WssRef } from '../../../src/project/model.js';

function ref(entries: unknown[]): WssRef {
  return { id: 'w1', name: 'Federated', document: { id: 'w1', name: 'Federated', entries } };
}

const issued = {
  kind: 'issued-token',
  stsUrl: 'https://sts.example.test/trust/13/usernamemixed',
  soapVersion: '1.2',
  trustVersion: '1.3',
  tokenType: '2.0',
  keyType: 'bearer',
  credential: { kind: 'username', username: 'alice', passwordRef: 'sec_sts' },
  requestedLifetimeSeconds: 0,
};

describe('SAML entry kinds in the project format', () => {
  it('loads an issued-token entry typed, not as an unknown kind', () => {
    const config = toWssOutgoingConfig(ref([issued]));
    expect(config.entries[0]).toMatchObject({ kind: 'issued-token', trustVersion: '1.3', keyType: 'bearer' });
  });

  it('loads both saml-token variants', () => {
    const config = toWssOutgoingConfig(
      ref([
        { kind: 'saml-token', source: 'xml', xml: '<saml2:Assertion/>', expandProperties: false },
        {
          kind: 'saml-token',
          source: 'form',
          version: '2.0',
          issuer: 'urn:test:issuer',
          subject: 'alice',
          confirmation: 'bearer',
          lifetimeSeconds: 300,
          attributes: [{ name: 'role', values: ['admin'] }],
        },
      ]),
    );
    expect(config.entries.map((entry) => entry.kind)).toEqual(['saml-token', 'saml-token']);
  });

  it('rejects a plaintext password nested in a credential', () => {
    const parsed = wssOutgoingFileSchema.safeParse({
      id: 'w1',
      name: 'Bad',
      entries: [{ ...issued, credential: { kind: 'username', username: 'alice', password: 'hunter2' } }],
    });
    expect(parsed.success).toBe(false);
  });

  it('round-trips an issued-token entry unchanged', () => {
    const config = toWssOutgoingConfig(ref([issued]));
    expect(toWssOutgoingRef(config).document['entries']).toEqual([issued]);
  });

  it('accepts the saml-token key identifier and the SamlToken part on a signature', () => {
    const config = toWssOutgoingConfig(
      ref([
        {
          kind: 'signature',
          keystoreRef: 'ks1',
          keyIdentifierType: 'saml-token',
          parts: [{ name: 'SamlToken', namespace: '', encode: 'Element', token: true }],
        },
      ]),
    );
    expect(config.entries[0]).toMatchObject({ keyIdentifierType: 'saml-token' });
  });
});
