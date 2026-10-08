import { describe, expect, it } from 'vitest';
import type { WssEntry } from '../../../src/wss/model.js';
import type { WssPolicy } from '../../../src/wss/policy/model.js';
import { checkWssPolicy, describeWssPolicy, proposeWssEntries, suiteAlgorithms } from '../../../src/wss/policy/plan.js';
import { NS } from '../../../src/xml/namespaces.js';

const BASE: WssPolicy = {
  version: '1.2',
  soapVersion: '1.1',
  binding: 'none',
  requiresTls: false,
  includeTimestamp: false,
  encryptBeforeSigning: false,
  tokens: [],
  signedParts: [],
  encryptedParts: [],
  unsupported: [],
  notes: [],
};

const TRANSPORT: WssPolicy = {
  ...BASE,
  binding: 'transport',
  requiresTls: true,
  includeTimestamp: true,
  algorithmSuite: 'Basic128',
  tokens: [{ kind: 'username', role: 'signed-supporting', password: 'digest' }],
};

const ASYMMETRIC: WssPolicy = {
  ...BASE,
  soapVersion: '1.2',
  binding: 'asymmetric',
  includeTimestamp: true,
  algorithmSuite: 'Basic256Sha256',
  tokens: [
    { kind: 'x509', role: 'initiator', reference: 'Thumbprint' },
    { kind: 'x509', role: 'recipient', reference: 'IssuerSerial' },
  ],
  signedParts: [
    { name: 'Body', namespace: NS.SOAP12_ENV },
    { name: 'To', namespace: NS.WSA_200508 },
  ],
  encryptedParts: [{ name: 'Body', namespace: NS.SOAP12_ENV }],
};

/** The proposal with what the user fills in by hand filled in. */
function filled(entries: readonly WssEntry[]): WssEntry[] {
  return entries.map((entry) => {
    if (entry.kind === 'username-token') {
      return { ...entry, username: 'alice' };
    }
    if (entry.kind === 'signature' || entry.kind === 'encryption') {
      return { ...entry, keystoreRef: 'ks' };
    }
    return entry;
  });
}

describe('suiteAlgorithms', () => {
  it.each([
    [
      'Basic256',
      {
        signatureAlgorithm: 'rsa-sha1',
        digestAlgorithm: 'sha1',
        symmetricAlgorithm: 'aes256-cbc',
        keyTransportAlgorithm: 'rsa-oaep',
      },
    ],
    [
      'Basic128Sha256',
      {
        signatureAlgorithm: 'rsa-sha256',
        digestAlgorithm: 'sha256',
        symmetricAlgorithm: 'aes128-cbc',
        keyTransportAlgorithm: 'rsa-oaep',
      },
    ],
    [
      'Basic256Sha256Rsa15',
      {
        signatureAlgorithm: 'rsa-sha256',
        digestAlgorithm: 'sha256',
        symmetricAlgorithm: 'aes256-cbc',
        keyTransportAlgorithm: 'rsa-1_5',
      },
    ],
    ['TripleDesRsa15', { signatureAlgorithm: 'rsa-sha1', digestAlgorithm: 'sha1', keyTransportAlgorithm: 'rsa-1_5' }],
  ])('maps %s', (suite, expected) => {
    expect(suiteAlgorithms(suite)).toEqual(expected);
  });

  it('knows nothing of a suite outside the table', () => {
    expect(suiteAlgorithms('Custom')).toBeUndefined();
  });
});

describe('proposeWssEntries', () => {
  it('proposes a timestamp and a digest username token for a transport policy', () => {
    expect(proposeWssEntries(TRANSPORT)).toEqual({
      entries: [
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
        { kind: 'username-token', username: '', passwordType: 'digest', addNonce: true, addCreated: true },
      ],
      notes: [],
    });
  });

  it('proposes a signature then an encryption with the suite’s algorithms and the token references', () => {
    const { entries, notes } = proposeWssEntries(ASYMMETRIC);
    expect(entries.map((entry) => entry.kind)).toEqual(['timestamp', 'signature', 'encryption']);
    expect(entries[1]).toEqual({
      kind: 'signature',
      keystoreRef: '',
      keyIdentifierType: 'Thumbprint',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: [
        { name: 'Body', namespace: NS.SOAP12_ENV, encode: 'Content' },
        { name: 'To', namespace: NS.WSA_200508, encode: 'Element' },
        { name: 'Timestamp', namespace: NS.WSU, encode: 'Content' },
      ],
    });
    expect(entries[2]).toEqual({
      kind: 'encryption',
      keystoreRef: '',
      keyIdentifierType: 'IssuerSerial',
      symmetricAlgorithm: 'aes256-cbc',
      keyTransportAlgorithm: 'rsa-oaep',
      embedKey: false,
      encryptSymmetricKey: true,
      parts: [{ name: 'Body', namespace: NS.SOAP12_ENV, encode: 'Content' }],
    });
    expect(notes).toEqual(['Pick the keystores the signature and encryption use in the configuration.']);
  });

  it('puts the encryption first when the policy encrypts before signing', () => {
    const { entries } = proposeWssEntries({ ...ASYMMETRIC, encryptBeforeSigning: true });
    expect(entries.map((entry) => entry.kind)).toEqual(['timestamp', 'encryption', 'signature']);
  });

  it('signs a signed supporting username token under an asymmetric binding', () => {
    const { entries } = proposeWssEntries({
      ...ASYMMETRIC,
      tokens: [...ASYMMETRIC.tokens, { kind: 'username', role: 'signed-supporting', password: 'text' }],
    });
    const signature = entries.find((entry) => entry.kind === 'signature');
    expect(signature?.kind === 'signature' ? signature.parts.map((part) => part.name) : []).toContain('UsernameToken');
  });

  it('proposes an issued token from the policy’s STS, in the policy’s WS-Trust version', () => {
    const { entries } = proposeWssEntries({
      ...BASE,
      version: '1.1',
      tokens: [{ kind: 'issued', role: 'supporting', issuer: 'https://sts.example.invalid/trust' }],
    });
    expect(entries).toEqual([
      {
        kind: 'issued-token',
        stsUrl: 'https://sts.example.invalid/trust',
        soapVersion: '1.1',
        trustVersion: '2005-02',
        tokenType: '2.0',
        keyType: 'bearer',
        credential: { kind: 'username', username: '' },
        requestedLifetimeSeconds: 0,
      },
    ]);
  });

  it('passes on what it cannot express and notes an unknown or unoffered suite', () => {
    expect(proposeWssEntries({ ...BASE, algorithmSuite: 'Custom', unsupported: ['XPath'] }).notes).toEqual([
      'The algorithm suite Custom is not known; the default algorithms are proposed.',
      'XPath',
    ]);
    const tripleDes = proposeWssEntries({ ...ASYMMETRIC, algorithmSuite: 'TripleDes' });
    expect(tripleDes.notes[0]).toBe('The TripleDes cipher is not offered; AES-256-CBC is proposed instead.');
  });
});

describe('checkWssPolicy', () => {
  it('is satisfied by its own proposal once the user fills it in', () => {
    for (const policy of [TRANSPORT, ASYMMETRIC, { ...ASYMMETRIC, encryptBeforeSigning: true }]) {
      const entries = filled(proposeWssEntries(policy).entries);
      expect(checkWssPolicy(policy, entries, 'https://svc.example.invalid/').satisfied).toBe(true);
    }
  });

  it('reports an unfilled proposal unmet, naming what is missing', () => {
    const check = checkWssPolicy(ASYMMETRIC, proposeWssEntries(ASYMMETRIC).entries, 'http://svc');
    expect(check.satisfied).toBe(false);
    expect(check.results.filter((entry) => !entry.met)).toEqual([
      { requirement: 'Signature', met: false, reason: 'No signing keystore is selected.' },
      { requirement: 'Encryption', met: false, reason: "No recipient's keystore is selected." },
    ]);
  });

  it('reports every requirement unmet when no configuration is selected', () => {
    const check = checkWssPolicy(TRANSPORT, [], 'http://svc');
    expect(check.results).toEqual([
      { requirement: 'HTTPS endpoint', met: false, reason: 'The endpoint does not use https://.' },
      { requirement: 'Timestamp', met: false, reason: 'No timestamp entry.' },
      { requirement: 'Username token (digest password)', met: false, reason: 'No username token entry.' },
    ]);
  });

  it('flags a username token sent the wrong way and an empty username', () => {
    const entries: WssEntry[] = [
      { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
      { kind: 'username-token', username: '', passwordType: 'text', addNonce: false, addCreated: false },
    ];
    const check = checkWssPolicy(TRANSPORT, entries, 'https://svc');
    expect(check.results.at(-1)).toEqual({
      requirement: 'Username token (digest password)',
      met: false,
      reason: 'The username is empty. The password is sent as text, not digest.',
    });
  });

  it('flags wrong algorithms, missing parts and the wrong order', () => {
    const entries = filled(proposeWssEntries(ASYMMETRIC).entries).map((entry): WssEntry => {
      if (entry.kind === 'signature') {
        return { ...entry, signatureAlgorithm: 'rsa-sha1', parts: entry.parts.slice(0, 1) };
      }
      if (entry.kind === 'encryption') {
        return { ...entry, symmetricAlgorithm: 'aes128-gcm', keyTransportAlgorithm: 'rsa-1_5' };
      }
      return entry;
    });
    const [timestamp, signature, encryption] = entries as [WssEntry, WssEntry, WssEntry];
    const check = checkWssPolicy(ASYMMETRIC, [timestamp, encryption, signature], undefined);
    expect(check.results.filter((entry) => !entry.met)).toEqual([
      {
        requirement: 'Signature',
        met: false,
        reason: 'Basic256Sha256 signs with rsa-sha256 and sha256. Missing parts: To, Timestamp.',
      },
      {
        requirement: 'Encryption',
        met: false,
        reason: 'Basic256Sha256 encrypts with aes256-cbc. Basic256Sha256 wraps the key with rsa-oaep.',
      },
      {
        requirement: 'Sign before encrypting',
        met: false,
        reason: 'The encryption entry comes before the signature.',
      },
    ]);
  });

  it('never claims a policy it cannot express is satisfied', () => {
    const check = checkWssPolicy({ ...BASE, binding: 'symmetric', unsupported: ['Symmetric'] }, [], undefined);
    expect(check).toEqual({
      satisfied: false,
      results: [{ requirement: 'Not offered', met: false, reason: 'Symmetric' }],
    });
  });
});

describe('describeWssPolicy', () => {
  it('lists tokens, parts, suite and TLS', () => {
    expect(describeWssPolicy(ASYMMETRIC)).toEqual([
      { label: 'Tokens', value: 'X.509 token (initiator, Thumbprint); X.509 token (recipient, IssuerSerial)' },
      { label: 'Signed', value: 'Body, To, Timestamp' },
      { label: 'Encrypted', value: 'Body' },
      { label: 'Algorithm suite', value: 'Basic256Sha256' },
      { label: 'TLS', value: 'Not required' },
      { label: 'Timestamp', value: 'Included' },
    ]);
  });
});
