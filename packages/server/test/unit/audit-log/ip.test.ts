import { describe, expect, it } from 'vitest';
import { auditIp } from '../../../src/context.js';

describe('auditIp (an address the inet column accepts, or none)', () => {
  it('keeps a plain IPv4 or IPv6 address', () => {
    expect(auditIp('203.0.113.7')).toBe('203.0.113.7');
    expect(auditIp('2001:db8::1')).toBe('2001:db8::1');
    expect(auditIp('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
  });

  it('drops an IPv6 zone and an IPv4 port', () => {
    expect(auditIp('fe80::1%eth0')).toBe('fe80::1');
    expect(auditIp('1.2.3.4:5678')).toBe('1.2.3.4');
  });

  it('gives no address for junk or nothing', () => {
    for (const junk of ['x', '', 'unknown', '1.2.3', '999.1.1.1', '1.2.3.4:', '[::1]:80', 'a%b']) {
      expect(auditIp(junk), junk).toBeUndefined();
    }
    expect(auditIp(undefined)).toBeUndefined();
  });
});
