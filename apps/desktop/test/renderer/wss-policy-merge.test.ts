import { describe, expect, it } from 'vitest';
import { mergeProposal } from '../../src/renderer/features/request-editor/wss-policy.js';
import type { WssEntryWire } from '../../src/shared/wire-types.js';

const SIGNATURE: WssEntryWire = {
  kind: 'signature',
  keystoreRef: '',
  keyIdentifierType: 'Thumbprint',
  signatureAlgorithm: 'rsa-sha256',
  digestAlgorithm: 'sha256',
  canonicalization: 'exc-c14n',
  useSingleCertificate: true,
  parts: [],
};

const ENCRYPTION: WssEntryWire = {
  kind: 'encryption',
  keystoreRef: '',
  keyIdentifierType: 'IssuerSerial',
  symmetricAlgorithm: 'aes256-cbc',
  keyTransportAlgorithm: 'rsa-oaep',
  embedKey: false,
  encryptSymmetricKey: true,
  parts: [],
};

const ISSUED: WssEntryWire = {
  kind: 'issued-token',
  stsUrl: '',
  soapVersion: '1.1',
  trustVersion: '2005-02',
  tokenType: '2.0',
  keyType: 'bearer',
  credential: { kind: 'username', username: '' },
  requestedLifetimeSeconds: 0,
};

describe('mergeProposal', () => {
  it('keeps the keystores, aliases and key password the user picked, and the policy’s algorithms', () => {
    const existing: WssEntryWire[] = [
      { ...SIGNATURE, keystoreRef: 'ks-sign', alias: 'me', keyPasswordRef: 'ref-k', signatureAlgorithm: 'rsa-sha1' },
      { ...ENCRYPTION, keystoreRef: 'ks-peer', alias: 'them', symmetricAlgorithm: 'aes128-gcm' },
    ];
    expect(mergeProposal(existing, [SIGNATURE, ENCRYPTION])).toEqual([
      { ...SIGNATURE, keystoreRef: 'ks-sign', alias: 'me', keyPasswordRef: 'ref-k' },
      { ...ENCRYPTION, keystoreRef: 'ks-peer', alias: 'them' },
    ]);
  });

  it('keeps who asks an STS, and the user’s STS address when the policy names none', () => {
    const existing: WssEntryWire[] = [
      {
        ...ISSUED,
        stsUrl: 'https://sts.corp/trust',
        trustVersion: '1.3',
        keyType: 'public-key',
        credential: { kind: 'username', username: 'svc', passwordRef: 'ref-s' },
      },
    ];
    expect(mergeProposal(existing, [ISSUED])).toEqual([
      {
        ...ISSUED,
        stsUrl: 'https://sts.corp/trust',
        keyType: 'public-key',
        credential: { kind: 'username', username: 'svc', passwordRef: 'ref-s' },
      },
    ]);
  });

  it('takes the proposal as it is where nothing of its kind existed, and drops what the policy no longer asks for', () => {
    const existing: WssEntryWire[] = [{ kind: 'timestamp', timeToLiveSeconds: 60, millisecondPrecision: true }];
    expect(mergeProposal(existing, [SIGNATURE])).toEqual([SIGNATURE]);
  });
});
