import { describe, expect, it } from 'vitest';
import { certificateExpiry, pemCertificates, tlsProbeTarget } from '../../../src/http/cert-expiry.js';
import { generateServerCert, generateTestCa } from '../../helpers/test-certs.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T12:00:00.000Z');

describe('certificateExpiry', () => {
  it('is ok outside the warning window', () => {
    expect(certificateExpiry(new Date(NOW + 45 * DAY).toISOString(), 30, NOW)).toEqual({
      status: 'ok',
      daysLeft: 45,
    });
  });

  it('is expiring inside the window, counting part of a day as a whole one', () => {
    expect(certificateExpiry(new Date(NOW + 30 * DAY).toISOString(), 30, NOW)).toEqual({
      status: 'expiring',
      daysLeft: 30,
    });
    expect(certificateExpiry(new Date(NOW + 60 * 60 * 1000).toISOString(), 30, NOW)).toEqual({
      status: 'expiring',
      daysLeft: 1,
    });
  });

  it('is expired at and after the end of validity', () => {
    expect(certificateExpiry(new Date(NOW).toISOString(), 30, NOW).status).toBe('expired');
    expect(certificateExpiry(new Date(NOW - 3 * DAY).toISOString(), 30, NOW)).toEqual({
      status: 'expired',
      daysLeft: -3,
    });
  });

  it('a window of 0 days only reports what has already expired', () => {
    expect(certificateExpiry(new Date(NOW + 60 * 1000).toISOString(), 0, NOW).status).toBe('ok');
  });

  it('is unknown for a date that does not parse', () => {
    expect(certificateExpiry('not a date', 30, NOW)).toEqual({ status: 'unknown' });
  });
});

describe('pemCertificates', () => {
  it('reads every certificate of a bundle, skipping text around and between them', () => {
    const ca = generateTestCa();
    const leaf = generateServerCert(ca);
    const summaries = pemCertificates(`# comment\n${leaf.certPem}\nBag Attributes\n${ca.certPem}`);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.subject).toContain('CN=localhost');
    expect(summaries[0]?.subject).not.toContain('\n');
    expect(summaries[0]?.issuer).toContain('CN=Wirebench Test CA');
    expect(summaries[1]?.subject).toContain('CN=Wirebench Test CA');
    expect(summaries[0]?.fingerprint256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(summaries[0]?.validTo ?? ''))).toBe(false);
  });

  it('skips a block that is not a certificate', () => {
    expect(pemCertificates('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toEqual([]);
  });
});

describe('tlsProbeTarget', () => {
  it('takes the scheme default port when the URL names none', () => {
    expect(tlsProbeTarget('https://example.test/svc?wsdl')).toEqual({ host: 'example.test', port: 443 });
    expect(tlsProbeTarget('wss://example.test/feed')).toEqual({ host: 'example.test', port: 443 });
    expect(tlsProbeTarget('grpcs://example.test')).toEqual({ host: 'example.test', port: 443 });
  });

  it('keeps an explicit port and unbrackets an IPv6 literal', () => {
    expect(tlsProbeTarget('https://example.test:8443/')).toEqual({ host: 'example.test', port: 8443 });
    expect(tlsProbeTarget('https://[::1]:9443/')).toEqual({ host: '::1', port: 9443 });
  });

  it('ignores what does not speak TLS, or is not a URL', () => {
    expect(tlsProbeTarget('http://example.test/')).toBeUndefined();
    expect(tlsProbeTarget('ws://example.test/')).toBeUndefined();
    expect(tlsProbeTarget('${baseUrl}/x')).toBeUndefined();
  });
});
