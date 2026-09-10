import { describe, expect, it } from 'vitest';
import { NS } from '../../../src/xml/namespaces.js';
import { NamespaceScope } from '../../../src/soap/namespace-scope.js';

describe('NamespaceScope', () => {
  it('pins xsd/xsi/soapenc and names seeds with mnemonics', () => {
    const scope = new NamespaceScope(['http://tempuri.org/', 'urn:wb:common']);
    expect(scope.prefixes()).toMatchObject({
      [NS.XSD]: 'xsd',
      [NS.XSI]: 'xsi',
      [NS.SOAP11_ENC]: 'soapenc',
      'http://tempuri.org/': 'tem',
      'urn:wb:common': 'com',
    });
  });

  it('declares only the namespaces actually used, in first-use order', () => {
    const scope = new NamespaceScope(['http://tempuri.org/', 'urn:wb:common']);
    expect(scope.declarations()).toEqual({});
    scope.use('urn:wb:common');
    scope.use('http://tempuri.org/');
    expect(Object.keys(scope.declarations())).toEqual(['com', 'tem']);
  });

  it('gives the empty namespace no prefix and never declares it', () => {
    const scope = new NamespaceScope([]);
    expect(scope.use('')).toBe('');
    expect(scope.declarations()).toEqual({});
  });

  it('allocates a prefix on demand for an unseeded namespace', () => {
    const scope = new NamespaceScope([]);
    expect(scope.use('urn:wb:late')).toBe('lat');
    expect(scope.use('urn:wb:late')).toBe('lat');
    expect(scope.declarations()).toEqual({ lat: 'urn:wb:late' });
  });

  it('skips empty seeds and de-duplicates them', () => {
    const scope = new NamespaceScope(['', 'urn:wb:common', 'urn:wb:common']);
    expect(Object.values(scope.prefixes()).filter((prefix) => prefix === 'com')).toHaveLength(1);
  });

  it('lets an override win over a pinned prefix', () => {
    const scope = new NamespaceScope(['urn:wb:common'], { 'urn:wb:x': 'xsd' });
    expect(scope.prefixes()['urn:wb:x']).toBe('xsd');
    // The XSD namespace can no longer be pinned to `xsd`; it gets a fallback.
    expect(scope.prefixes()[NS.XSD]).toBeUndefined();
    expect(scope.use(NS.XSD)).toBe('xml1');
  });

  it('records the prefixes a generated fragment declared', () => {
    const scope = new NamespaceScope([]);
    scope.markUsed({ ns1: 'urn:wb:frag' });
    expect(scope.declares('ns1', 'urn:wb:frag')).toBe(true);
    expect(scope.declares('ns1', 'urn:other')).toBe(false);
    expect(scope.use('urn:wb:frag')).toBe('ns1');
  });
});
