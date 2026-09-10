import { describe, expect, it } from 'vitest';
import { assignFileNames } from '../../../src/wsdl/cache-naming.js';
import type { BundledDocument } from '../../../src/wsdl/resolver.js';

/** Builds a minimal `BundledDocument` for naming tests; only the fields `assignFileNames` reads matter. */
function doc(location: string, kind: 'wsdl' | 'xsd' = 'wsdl'): BundledDocument {
  return {
    location,
    requestedLocation: location,
    bytes: new Uint8Array(),
    text: '',
    kind,
    document: { documentElement: null } as unknown as BundledDocument['document'],
  };
}

describe('assignFileNames', () => {
  it('uses the last path segment when it looks like a file name', () => {
    const named = assignFileNames([
      doc('http://example.invalid/wsdl/service.wsdl'),
      doc('http://example.invalid/xsd/common.xsd', 'xsd'),
    ]);
    expect(named.map((n) => n.file)).toEqual(['service.wsdl', 'common.xsd']);
  });

  it('falls back to service.wsdl for an extensionless root (e.g. a ?wsdl query URL)', () => {
    const named = assignFileNames([doc('http://example.invalid/service?wsdl')]);
    expect(named[0]?.file).toBe('service.wsdl');
  });

  it('falls back to document-N.<kind> for an extensionless non-root document', () => {
    const named = assignFileNames([
      doc('http://example.invalid/root.wsdl'),
      doc('http://example.invalid/imported?xsd', 'xsd'),
    ]);
    expect(named[1]?.file).toBe('document-1.xsd');
  });

  it('de-duplicates colliding names with a numeric suffix, case-insensitively', () => {
    const named = assignFileNames([
      doc('http://a.invalid/common.xsd', 'xsd'),
      doc('http://b.invalid/common.xsd', 'xsd'),
      doc('http://c.invalid/COMMON.xsd', 'xsd'),
    ]);
    expect(named.map((n) => n.file)).toEqual(['common.xsd', 'common-2.xsd', 'COMMON-3.xsd']);
  });

  it('falls back for an unparsable non-root location', () => {
    const named = assignFileNames([doc('http://example.invalid/root.wsdl'), doc('not a url at all', 'xsd')]);
    expect(named[1]?.file).toBe('document-1.xsd');
  });

  it('falls back to service.wsdl for an unparsable root location', () => {
    const named = assignFileNames([doc('not a url at all', 'xsd')]);
    expect(named[0]?.file).toBe('service.wsdl');
  });
});
