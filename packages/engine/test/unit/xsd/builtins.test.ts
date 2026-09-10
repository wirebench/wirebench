import { describe, expect, it } from 'vitest';
import { NS } from '../../../src/xml/namespaces.js';
import { BUILTIN_TYPES, XSD_BUILTIN_NAMES, isBuiltinType, lookupBuiltin } from '../../../src/xsd/builtins.js';

const EXPECTED_NAMES = [
  'string',
  'boolean',
  'decimal',
  'float',
  'double',
  'duration',
  'dateTime',
  'time',
  'date',
  'gYearMonth',
  'gYear',
  'gMonthDay',
  'gDay',
  'gMonth',
  'hexBinary',
  'base64Binary',
  'anyURI',
  'QName',
  'NOTATION',
  'normalizedString',
  'token',
  'language',
  'NMTOKEN',
  'NMTOKENS',
  'Name',
  'NCName',
  'ID',
  'IDREF',
  'IDREFS',
  'ENTITY',
  'ENTITIES',
  'integer',
  'nonPositiveInteger',
  'negativeInteger',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
  'positiveInteger',
  'anyType',
  'anySimpleType',
];

describe('XSD built-in type table', () => {
  it('contains every XSD 1.0 built-in name', () => {
    expect([...XSD_BUILTIN_NAMES].sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it.each(EXPECTED_NAMES)('%s is registered with a sample value and the "?" placeholder', (name) => {
    const builtin = lookupBuiltin({ namespaceUri: NS.XSD, localName: name });
    expect(builtin).toBeDefined();
    expect(builtin?.name).toEqual({ namespaceUri: NS.XSD, localName: name });
    expect(builtin?.placeholder).toBe('?');
    expect(typeof builtin?.sampleValue).toBe('string');
  });

  it.each([
    ['int', '1'],
    ['string', 'string'],
    ['boolean', 'true'],
    ['double', '1.0'],
    ['float', '1.0'],
    ['decimal', '1.0'],
    ['date', '2000-01-01'],
    ['dateTime', '2000-01-01T00:00:00'],
    ['anyURI', 'http://example.com'],
    ['base64Binary', 'YQ=='],
  ])('%s has the SoapUI-parity sample value %s', (name, sample) => {
    expect(lookupBuiltin({ namespaceUri: NS.XSD, localName: name })?.sampleValue).toBe(sample);
  });

  it('marks primitives and records derivation bases', () => {
    expect(lookupBuiltin({ namespaceUri: NS.XSD, localName: 'string' })?.primitive).toBe(true);
    const token = lookupBuiltin({ namespaceUri: NS.XSD, localName: 'token' });
    expect(token?.primitive).toBe(false);
    expect(token?.base).toEqual({ namespaceUri: NS.XSD, localName: 'normalizedString' });
  });

  it('treats soapenc:X as an alias of xs:X for built-in names', () => {
    const alias = lookupBuiltin({ namespaceUri: NS.SOAP11_ENC, localName: 'int' });
    expect(alias?.sampleValue).toBe('1');
    expect(alias?.aliasOf).toEqual({ namespaceUri: NS.XSD, localName: 'int' });
    expect(isBuiltinType({ namespaceUri: NS.SOAP11_ENC, localName: 'string' })).toBe(true);
  });

  it('exposes soapenc:Array as a complex built-in flagged soapEncArray', () => {
    const array = lookupBuiltin({ namespaceUri: NS.SOAP11_ENC, localName: 'Array' });
    expect(array?.soapEncArray).toBe(true);
    expect(array?.complex).toBe(true);
  });

  it('rejects unknown names', () => {
    expect(isBuiltinType({ namespaceUri: NS.XSD, localName: 'nope' })).toBe(false);
    expect(lookupBuiltin({ namespaceUri: 'urn:x', localName: 'string' })).toBeUndefined();
    expect(lookupBuiltin({ namespaceUri: NS.SOAP11_ENC, localName: 'nope' })).toBeUndefined();
  });

  it('is exposed as a frozen map keyed by Clark notation', () => {
    expect(BUILTIN_TYPES.get(`{${NS.XSD}}string`)?.name.localName).toBe('string');
  });
});
