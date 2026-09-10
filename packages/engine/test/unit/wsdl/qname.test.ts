import { describe, expect, it } from 'vitest';
import { parseQName, qnameEquals, qnameToString } from '../../../src/wsdl/qname.js';
import { parseXml } from '../../../src/xml/parse.js';

describe('parseQName', () => {
  it('resolves an unprefixed name to the given default namespace', () => {
    const doc = parseXml('<root/>');
    const root = doc.documentElement;
    if (root === null) {
      throw new Error('expected root element');
    }
    expect(parseQName('Foo', root, 'urn:default')).toEqual({ namespaceUri: 'urn:default', localName: 'Foo' });
  });

  it('resolves an unprefixed name to the empty namespace when no default is given', () => {
    const doc = parseXml('<root/>');
    const root = doc.documentElement;
    if (root === null) {
      throw new Error('expected root element');
    }
    expect(parseQName('Foo', root)).toEqual({ namespaceUri: '', localName: 'Foo' });
  });

  it('resolves a prefixed name via the element scope', () => {
    const doc = parseXml('<root xmlns:tns="urn:x"><child/></root>');
    const child = doc.getElementsByTagName('child')[0];
    if (child === undefined) {
      throw new Error('expected child element');
    }
    expect(parseQName('tns:Foo', child)).toEqual({ namespaceUri: 'urn:x', localName: 'Foo' });
  });

  it('throws for an unbound prefix', () => {
    const doc = parseXml('<root/>');
    const root = doc.documentElement;
    if (root === null) {
      throw new Error('expected root element');
    }
    expect(() => parseQName('missing:Foo', root)).toThrow(/Unbound namespace prefix/);
  });

  it('resolves an unprefixed name to the in-scope XML default namespace over the given fallback', () => {
    const doc = parseXml('<root xmlns="urn:default-in-scope"><child/></root>');
    const child = doc.getElementsByTagName('child')[0];
    if (child === undefined) {
      throw new Error('expected child element');
    }
    expect(parseQName('Foo', child, 'urn:fallback')).toEqual({
      namespaceUri: 'urn:default-in-scope',
      localName: 'Foo',
    });
  });

  it('falls back to the given default namespace when no default namespace is declared in scope', () => {
    const doc = parseXml('<root><child/></root>');
    const child = doc.getElementsByTagName('child')[0];
    if (child === undefined) {
      throw new Error('expected child element');
    }
    expect(parseQName('Foo', child, 'urn:fallback')).toEqual({ namespaceUri: 'urn:fallback', localName: 'Foo' });
  });
});

describe('qnameEquals', () => {
  it('is true for matching namespace and local name', () => {
    expect(qnameEquals({ namespaceUri: 'urn:x', localName: 'A' }, { namespaceUri: 'urn:x', localName: 'A' })).toBe(
      true,
    );
  });

  it('is false when the namespace differs', () => {
    expect(qnameEquals({ namespaceUri: 'urn:x', localName: 'A' }, { namespaceUri: 'urn:y', localName: 'A' })).toBe(
      false,
    );
  });

  it('is false when the local name differs', () => {
    expect(qnameEquals({ namespaceUri: 'urn:x', localName: 'A' }, { namespaceUri: 'urn:x', localName: 'B' })).toBe(
      false,
    );
  });
});

describe('qnameToString', () => {
  it('renders Clark notation', () => {
    expect(qnameToString({ namespaceUri: 'urn:x', localName: 'A' })).toBe('{urn:x}A');
  });
});
