import { describe, expect, it } from 'vitest';
import { captureSslInfo, type TlsSocketLike } from '../../../src/http/tls.js';

interface FakeCert {
  subject?: Record<string, string | string[]>;
  issuer?: Record<string, string | string[]>;
  subjectaltname?: string;
  valid_from?: string;
  valid_to?: string;
  serialNumber?: string;
  fingerprint256?: string;
  ca?: boolean;
  issuerCertificate?: FakeCert;
}

function socket(cert: FakeCert | undefined, extra: Partial<TlsSocketLike> = {}): TlsSocketLike {
  return {
    getPeerCertificate: () => cert,
    getProtocol: () => 'TLSv1.3',
    getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384' }),
    authorized: true,
    ...extra,
  };
}

const LEAF: FakeCert = {
  subject: { CN: 'localhost', O: 'Wirebench' },
  issuer: { CN: 'Wirebench Test CA' },
  subjectaltname: 'DNS:localhost, IP Address:127.0.0.1',
  valid_from: 'Sep 10 00:00:00 2026 GMT',
  valid_to: 'Sep 11 00:00:00 2026 GMT',
  serialNumber: '01',
  fingerprint256: 'AB:CD:' + '00:'.repeat(29) + 'EF',
};

describe('captureSslInfo', () => {
  it('reads protocol, cipher, authorization and servername off the socket', () => {
    const info = captureSslInfo(socket(LEAF, { servername: 'localhost', alpnProtocol: 'http/1.1' }));

    expect(info.protocol).toBe('TLSv1.3');
    expect(info.cipher).toBe('TLS_AES_256_GCM_SHA384');
    expect(info.authorized).toBe(true);
    expect(info.servername).toBe('localhost');
    expect(info.alpn).toBe('http/1.1');
  });

  it('renders the leaf certificate: DN strings, ISO validity, SANs and a bare-hex fingerprint', () => {
    const info = captureSslInfo(socket(LEAF));

    expect(info.peerChain).toHaveLength(1);
    const leaf = info.peerChain[0]!;
    expect(leaf.subject).toBe('CN=localhost, O=Wirebench');
    expect(leaf.issuer).toBe('CN=Wirebench Test CA');
    expect(leaf.validFrom).toBe(new Date('Sep 10 00:00:00 2026 GMT').toISOString());
    expect(leaf.validTo).toBe(new Date('Sep 11 00:00:00 2026 GMT').toISOString());
    expect(leaf.sans).toEqual(['localhost', '127.0.0.1']);
    expect(leaf.serialNumber).toBe('01');
    expect(leaf.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('walks issuerCertificate up to the self-signed root', () => {
    const root: FakeCert = {
      subject: { CN: 'Wirebench Test CA' },
      issuer: { CN: 'Wirebench Test CA' },
      ca: true,
      fingerprint256: 'FF',
    };
    root.issuerCertificate = root;
    const leaf: FakeCert = { ...LEAF, issuerCertificate: root };

    const info = captureSslInfo(socket(leaf));

    expect(info.peerChain.map((cert) => cert.subject)).toEqual(['CN=localhost, O=Wirebench', 'CN=Wirebench Test CA']);
    expect(info.peerChain[1]?.isCA).toBe(true);
  });

  it('stops on a cycle that never reaches a self-signed certificate', () => {
    const a: FakeCert = { subject: { CN: 'A' }, issuer: { CN: 'B' } };
    const b: FakeCert = { subject: { CN: 'B' }, issuer: { CN: 'A' } };
    a.issuerCertificate = b;
    b.issuerCertificate = a;

    const info = captureSslInfo(socket(a));

    expect(info.peerChain.map((cert) => cert.subject)).toEqual(['CN=A', 'CN=B']);
  });

  it('survives a socket with no peer certificate and no optional accessors', () => {
    const info = captureSslInfo({ getPeerCertificate: () => ({}) });

    expect(info.peerChain).toEqual([]);
    expect(info.protocol).toBeUndefined();
    expect(info.cipher).toBeUndefined();
    expect(info.authorized).toBeUndefined();
  });

  it('reports an authorization error as its message and keeps unparseable validity verbatim', () => {
    const info = captureSslInfo(
      socket(
        { subject: { CN: 'x' }, issuer: { CN: 'y' }, valid_from: 'not a date', valid_to: 'nor this' },
        {
          authorized: false,
          authorizationError: new Error('SELF_SIGNED_CERT_IN_CHAIN'),
        },
      ),
    );

    expect(info.authorized).toBe(false);
    expect(info.authorizationError).toBe('SELF_SIGNED_CERT_IN_CHAIN');
    expect(info.peerChain[0]?.validFrom).toBe('not a date');
    expect(info.peerChain[0]?.validTo).toBe('nor this');
  });

  it('joins multi-valued DN attributes and ignores a false servername/alpn', () => {
    const info = captureSslInfo(
      socket({ subject: { CN: 'x', OU: ['a', 'b'] }, issuer: { CN: 'y' } }, { servername: false, alpnProtocol: false }),
    );

    expect(info.peerChain[0]?.subject).toBe('CN=x, OU=a, OU=b');
    expect(info.servername).toBeUndefined();
    expect(info.alpn).toBeUndefined();
  });
});
