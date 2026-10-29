import { generateKeyPairSync, sign } from 'node:crypto';
import { AGENT_PAIRING_CODE_PATTERN, agentRedeemMessage, agentRequestMessage } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { hashPairingCode, newPairingCode, normalizePairingCode } from '../../../src/agent/codes.js';
import {
  agentHeaders,
  checkAgentSignature,
  parseAgentPublicKey,
  signatureValid,
  timestampFresh,
} from '../../../src/agent/signature.js';

const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (message: string) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
  };
};

const NOW = new Date('2026-10-29T12:00:00.000Z');

describe('agent signatures (hosted edition spec §18.2)', () => {
  it('verifies a signature over the redeem message with the key that made it', () => {
    const k = keys();
    const message = agentRedeemMessage('n0nce', '01JABCDEFGHJKMNPQRSTVWXYZ0', NOW.toISOString());
    expect(message).toBe(`n0nce\n01JABCDEFGHJKMNPQRSTVWXYZ0\n${NOW.toISOString()}`);
    expect(signatureValid(k.publicKey, message, k.sign(message))).toBe(true);
  });

  it('refuses another key, another message, a truncated or non-base64 signature', () => {
    const k = keys();
    const other = keys();
    const message = agentRequestMessage('delete', '/api/v1/agent/pairings/x', 'x', NOW.toISOString());
    expect(message.startsWith('DELETE\n/api/v1/agent/pairings/x\nx\n')).toBe(true);
    const signature = k.sign(message);
    expect(signatureValid(other.publicKey, message, signature)).toBe(false);
    expect(signatureValid(k.publicKey, `${message}!`, signature)).toBe(false);
    expect(signatureValid(k.publicKey, message, signature.slice(0, 40))).toBe(false);
    expect(signatureValid(k.publicKey, message, '!!not base64!!')).toBe(false);
  });

  it('parses only an Ed25519 SPKI key', () => {
    expect(parseAgentPublicKey(keys().publicKey)?.asymmetricKeyType).toBe('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' });
    expect(parseAgentPublicKey(rsa.toString('base64'))).toBeUndefined();
    expect(parseAgentPublicKey('AAAA')).toBeUndefined();
    expect(parseAgentPublicKey('not a key')).toBeUndefined();
  });

  it('takes a timestamp up to 60 s away either way, and only ISO-8601', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(timestampFresh(at(0), NOW)).toBe(true);
    expect(timestampFresh(at(-60_000), NOW)).toBe(true);
    expect(timestampFresh(at(60_000), NOW)).toBe(true);
    expect(timestampFresh(at(-60_001), NOW)).toBe(false);
    expect(timestampFresh(at(60_001), NOW)).toBe(false);
    expect(timestampFresh(String(NOW.getTime()), NOW)).toBe(false);
    expect(timestampFresh('Thu, 29 Oct 2026 12:00:00 GMT', NOW)).toBe(false);
  });

  it('checks the timestamp before the signature', () => {
    const k = keys();
    const stale = new Date(NOW.getTime() - 61_000).toISOString();
    const message = agentRedeemMessage('n', 'p', stale);
    expect(
      checkAgentSignature({ publicKey: k.publicKey, message, timestamp: stale, signature: k.sign(message) }, NOW),
    ).toBe('timestamp');
    const fresh = NOW.toISOString();
    const good = agentRedeemMessage('n', 'p', fresh);
    expect(
      checkAgentSignature({ publicKey: k.publicKey, message: good, timestamp: fresh, signature: k.sign(message) }, NOW),
    ).toBe('signature');
    expect(
      checkAgentSignature({ publicKey: k.publicKey, message: good, timestamp: fresh, signature: k.sign(good) }, NOW),
    ).toBeUndefined();
  });

  it('reads the three agent headers, or nothing when one is missing', () => {
    const all = {
      'x-wirebench-agent-pairing': 'p',
      'x-wirebench-agent-timestamp': 't',
      'x-wirebench-agent-signature': 's',
    };
    expect(agentHeaders(all)).toEqual({ pairingId: 'p', timestamp: 't', signature: 's' });
    expect(agentHeaders({ ...all, 'x-wirebench-agent-signature': undefined })).toBeUndefined();
    expect(agentHeaders({ ...all, 'x-wirebench-agent-pairing': ['a', 'b'] })).toBeUndefined();
  });
});

describe('pairing codes', () => {
  it('draws six characters from the alphabet without look-alikes', () => {
    for (let i = 0; i < 200; i++) expect(newPairingCode()).toMatch(AGENT_PAIRING_CODE_PATTERN);
  });

  it('forgives case, spaces and dashes, and refuses look-alikes and other lengths', () => {
    expect(normalizePairingCode('ab3-k7z')).toBe('AB3K7Z');
    expect(normalizePairingCode(' AB3 K7Z ')).toBe('AB3K7Z');
    expect(normalizePairingCode('AB3K7O')).toBeUndefined();
    expect(normalizePairingCode('AB3K71')).toBeUndefined();
    expect(normalizePairingCode('AB3K7')).toBeUndefined();
  });

  it('hashes, never stores the code itself', () => {
    expect(hashPairingCode('AB3K7Z')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPairingCode('AB3K7Z')).not.toBe(hashPairingCode('AB3K7Y'));
  });
});
