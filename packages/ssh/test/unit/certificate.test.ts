import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  certificateMatchesKey,
  certificateValidity,
  describePrivateKey,
  formatValidity,
  looksLikeCertificate,
  parseCertificate,
} from '../../src/index.js';

// Made once with ssh-keygen (`-s ca -I … -n … -V … -z …`) and committed: test-only keys, used nowhere else.
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/certs/${name}`, import.meta.url), 'utf8');

const UTC = (iso: string): number => Date.parse(iso);

describe('parseCertificate', () => {
  it('reads an Ed25519 user certificate: key ID, serial, principals, validity and the signing CA', () => {
    const cert = parseCertificate(fixture('user_ed25519-cert.pub'));
    expect(cert).toMatchObject({
      certType: 'ssh-ed25519-cert-v01@openssh.com',
      keyType: 'ssh-ed25519',
      kind: 'user',
      keyId: 'alice@example',
      serial: '42',
      principals: ['alice', 'deploy'],
      validAfter: UTC('2020-01-01T00:00:00Z'),
      validBefore: UTC('2099-12-31T23:59:59Z'),
      criticalOptions: [],
      caKeyType: 'ssh-ed25519',
    });
    expect(cert.extensions).toContain('permit-pty');
    // The fingerprints ssh-keygen -L prints for the CA and, for the key, `ssh-keygen -l` of the plain key.
    expect(cert.caFingerprint).toBe('SHA256:vB5oARcV1UTfAV+1JF6lo66WAGXVjH4Xx+b4lIQy4Ig');
    expect(cert.publicKeyFingerprint).toBe(describePrivateKey(fixture('user_ed25519')).fingerprint);
  });

  it('reads ECDSA and RSA certificates, and "always"/"forever" as no bound', () => {
    const ecdsa = parseCertificate(fixture('user_ecdsa-cert.pub'));
    expect(ecdsa).toMatchObject({ keyType: 'ecdsa-sha2-nistp256', keyId: 'alice-ecdsa', serial: '43' });
    expect(ecdsa.publicKeyFingerprint).toBe(describePrivateKey(fixture('user_ecdsa')).fingerprint);
    const rsa = parseCertificate(fixture('user_rsa-cert.pub'));
    expect(rsa).toMatchObject({ keyType: 'ssh-rsa', validAfter: null, validBefore: null, principals: ['alice'] });
    expect(rsa.publicKeyFingerprint).toBe(describePrivateKey(fixture('user_rsa')).fingerprint);
  });

  it('tells a host certificate from a user one', () => {
    expect(parseCertificate(fixture('user_ed25519-host-cert.pub')).kind).toBe('host');
  });

  it('keeps the whole blob and the line, comment included', () => {
    const text = fixture('user_ed25519-cert.pub');
    const cert = parseCertificate(`\n  ${text}`);
    expect(cert.line).toBe(text.trim());
    expect(cert.blob.toString('base64')).toBe(text.split(' ')[1]);
  });

  it('refuses a plain public key, a private key, garbage and a truncated blob', () => {
    const refused = { code: 'ssh-cert-invalid' };
    expect(() => parseCertificate(fixture('user_ed25519.pub'))).toThrow(expect.objectContaining(refused));
    expect(() => parseCertificate(fixture('user_ed25519'))).toThrow(expect.objectContaining(refused));
    expect(() => parseCertificate('hunter2')).toThrow(expect.objectContaining(refused));
    const [type = '', base64 = ''] = fixture('user_ed25519-cert.pub').split(' ');
    const truncated = Buffer.from(base64, 'base64').subarray(0, 120).toString('base64');
    expect(() => parseCertificate(`${type} ${truncated}`)).toThrow(expect.objectContaining(refused));
  });

  it('never echoes the input in its message', () => {
    try {
      parseCertificate('ssh-ed25519-cert-v01@openssh.com c2VjcmV0');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('c2VjcmV0');
    }
  });
});

describe('looksLikeCertificate', () => {
  it('is true only for a certificate line', () => {
    expect(looksLikeCertificate(fixture('user_rsa-cert.pub'))).toBe(true);
    expect(looksLikeCertificate(fixture('user_rsa.pub'))).toBe(false);
    expect(looksLikeCertificate(fixture('user_rsa'))).toBe(false);
  });
});

describe('certificateValidity', () => {
  const cert = parseCertificate(fixture('user_ed25519-cert.pub'));

  it('is valid inside the window, bounds included', () => {
    expect(certificateValidity(cert, UTC('2026-10-13T00:00:00Z'))).toBe('valid');
    expect(certificateValidity(cert, UTC('2020-01-01T00:00:00Z'))).toBe('valid');
    expect(certificateValidity(cert, UTC('2099-12-31T23:59:59Z'))).toBe('valid');
  });

  it('is not yet valid before it and expired after it', () => {
    expect(certificateValidity(cert, UTC('2019-12-31T23:59:59Z'))).toBe('not-yet-valid');
    expect(certificateValidity(cert, UTC('2100-01-01T00:00:00Z'))).toBe('expired');
    expect(certificateValidity(parseCertificate(fixture('user_ed25519-expired-cert.pub')), Date.now())).toBe('expired');
  });

  it('is always valid without bounds', () => {
    expect(certificateValidity(parseCertificate(fixture('user_rsa-cert.pub')), 0)).toBe('valid');
  });
});

describe('formatValidity', () => {
  it('prints the window in UTC, and open bounds as words', () => {
    expect(formatValidity(parseCertificate(fixture('user_ed25519-expired-cert.pub')))).toBe(
      'from 2000-01-01 00:00:00 UTC to 2001-01-01 00:00:00 UTC',
    );
    expect(formatValidity(parseCertificate(fixture('user_rsa-cert.pub')))).toBe('always valid');
  });
});

describe('certificateMatchesKey', () => {
  it('pairs a certificate with the key it certifies, and only that one', () => {
    const cert = parseCertificate(fixture('user_ed25519-cert.pub'));
    expect(certificateMatchesKey(cert, describePrivateKey(fixture('user_ed25519')))).toBe(true);
    expect(certificateMatchesKey(cert, describePrivateKey(fixture('user_ecdsa')))).toBe(false);
  });
});
