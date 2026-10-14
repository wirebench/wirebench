import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dialChain } from '../../src/index.js';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/certs/${name}`, import.meta.url), 'utf8');

// Port 1 is never dialled: every refusal here comes before the network.
const dialWith = (key: string, certificate: string) =>
  dialChain({
    hops: [
      {
        address: '127.0.0.1',
        port: 1,
        user: 'alice',
        auth: { kind: 'key', privateKey: fixture(key), certificate: fixture(certificate) },
        keepAlive: 0,
        connectTimeout: 5,
      },
    ],
    verifyHostKey: () => Promise.reject(new Error('dialled')),
  });

describe('certificate checks before connecting', () => {
  it('refuses an expired certificate with its validity window', async () => {
    await expect(dialWith('user_ed25519', 'user_ed25519-expired-cert.pub')).rejects.toMatchObject({
      code: 'ssh-cert-expired',
      message:
        '127.0.0.1:1: The certificate has expired: it was valid from 2000-01-01 00:00:00 UTC to 2001-01-01 00:00:00 UTC',
      details: {
        host: '127.0.0.1:1',
        validity: 'expired',
        validAfter: Date.parse('2000-01-01T00:00:00Z'),
        validBefore: Date.parse('2001-01-01T00:00:00Z'),
      },
    });
  });

  it('refuses a certificate that is not valid yet', async () => {
    await expect(dialWith('user_ed25519', 'user_ed25519-future-cert.pub')).rejects.toMatchObject({
      code: 'ssh-cert-expired',
      details: { validity: 'not-yet-valid' },
    });
  });

  it('refuses a host certificate', async () => {
    await expect(dialWith('user_ed25519', 'user_ed25519-host-cert.pub')).rejects.toMatchObject({
      code: 'ssh-cert-invalid',
    });
  });

  it('refuses a certificate issued for another key', async () => {
    await expect(dialWith('user_ecdsa', 'user_ed25519-cert.pub')).rejects.toMatchObject({
      code: 'ssh-cert-mismatch',
    });
  });

  it('refuses a secret that is not a certificate', async () => {
    await expect(dialWith('user_ed25519', 'user_ed25519.pub')).rejects.toMatchObject({ code: 'ssh-cert-invalid' });
  });
});
