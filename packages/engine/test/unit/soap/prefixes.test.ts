import { describe, expect, it } from 'vitest';
import { prefixForNamespace, RESERVED_PREFIXES } from '../../../src/soap/prefixes.js';

describe('prefixForNamespace', () => {
  const none = new Set<string>();

  it.each([
    ['http://tempuri.org/', 'tem'],
    ['http://www.oorsprong.org/websamples.countryinfo', 'web'],
    ['http://www.dataaccess.com/webservicesserver/', 'web'],
    ['urn:wb:common', 'com'],
    ['urn:wb:rpclit', 'rpc'],
    ['urn:wb:headers', 'hea'],
    ['https://www.w3schools.com/xml/temperature', 'tem'],
  ])('derives a mnemonic from %s', (uri, expected) => {
    expect(prefixForNamespace(uri, none)).toBe(expected);
  });

  it('uses the whole token when it is shorter than the mnemonic length', () => {
    expect(prefixForNamespace('urn:wb:sc', none)).toBe('sc');
  });

  it('falls back to the host when the URI has no path', () => {
    expect(prefixForNamespace('http://www.example.com', none)).toBe('exa');
  });

  it('never returns a reserved prefix', () => {
    // `https://www.w3schools.com/xml/` would otherwise yield the reserved `xml`.
    const prefix = prefixForNamespace('https://www.w3schools.com/xml/', none);
    expect(RESERVED_PREFIXES).not.toContain(prefix);
    expect(prefix).toBe('xml1');
  });

  it('disambiguates collisions with a numeric suffix', () => {
    const taken = new Set<string>(['web']);
    expect(prefixForNamespace('http://a.example/webservices', taken)).toBe('web1');
    expect(prefixForNamespace('http://a.example/webservices', new Set(['web', 'web1']))).toBe('web2');
  });

  it('falls back to ns<n> when no mnemonic can be derived', () => {
    expect(prefixForNamespace('::', none)).toBe('ns1');
    expect(prefixForNamespace('http://example.com/%20/', none)).toBe('ns1');
  });

  it('strips leading digits and non-alphanumerics', () => {
    expect(prefixForNamespace('http://example.com/2005/payment-api', none)).toBe('pay');
  });

  it('is deterministic', () => {
    expect(prefixForNamespace('http://tempuri.org/', none)).toBe(prefixForNamespace('http://tempuri.org/', none));
  });
});
