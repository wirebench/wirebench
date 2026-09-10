import { describe, expect, it } from 'vitest';
import { extractReferences, resolveReferenceUrl, deriveFilename } from './wsdl-references.js';

describe('extractReferences', () => {
  it('extracts wsdl:import location', () => {
    const xml = `<definitions><wsdl:import namespace="ns" location="Other.wsdl"/></definitions>`;
    expect(extractReferences(xml)).toEqual(['Other.wsdl']);
  });

  it('extracts xs:import schemaLocation', () => {
    const xml = `<schema><xs:import namespace="ns" schemaLocation="types.xsd"/></schema>`;
    expect(extractReferences(xml)).toEqual(['types.xsd']);
  });

  it('extracts xs:include', () => {
    const xml = `<schema><xs:include schemaLocation="common.xsd"/></schema>`;
    expect(extractReferences(xml)).toEqual(['common.xsd']);
  });

  it('extracts multiple mixed references', () => {
    const xml = `
      <definitions>
        <wsdl:import namespace="a" location="a.wsdl"/>
        <schema>
          <xs:import namespace="b" schemaLocation="b.xsd"/>
          <xs:include schemaLocation="c.xsd"/>
        </schema>
      </definitions>`;
    expect(extractReferences(xml)).toEqual(['a.wsdl', 'b.xsd', 'c.xsd']);
  });

  it('de-duplicates repeated references', () => {
    const xml = `
      <definitions>
        <xs:include schemaLocation="common.xsd"/>
        <xs:include schemaLocation="common.xsd"/>
      </definitions>`;
    expect(extractReferences(xml)).toEqual(['common.xsd']);
  });

  it('returns empty array when no references present', () => {
    expect(extractReferences('<definitions></definitions>')).toEqual([]);
  });

  it('extracts xsd:import (xsd prefix) schemaLocation', () => {
    const xml = `<schema><xsd:import namespace="ns" schemaLocation="types.xsd"/></schema>`;
    expect(extractReferences(xml)).toEqual(['types.xsd']);
  });

  it('extracts s:import (s prefix) schemaLocation', () => {
    const xml = `<schema><s:import namespace="ns" schemaLocation="types.xsd"/></schema>`;
    expect(extractReferences(xml)).toEqual(['types.xsd']);
  });

  it('extracts prefix-less import with location', () => {
    const xml = `<definitions><import namespace="ns" location="Other.wsdl"/></definitions>`;
    expect(extractReferences(xml)).toEqual(['Other.wsdl']);
  });

  it('extracts xs:include with single-quoted schemaLocation', () => {
    const xml = `<schema><xs:include schemaLocation='common.xsd'/></schema>`;
    expect(extractReferences(xml)).toEqual(['common.xsd']);
  });

  it('extracts a reference when attribute order is swapped', () => {
    const xml = `<schema><xs:import schemaLocation="types.xsd" namespace="ns"/></schema>`;
    expect(extractReferences(xml)).toEqual(['types.xsd']);
  });

  it('does not match an element whose local name merely starts with import/include', () => {
    const xml = `<definitions><importantNote location="not-a-reference.xsd"/><includedSummary schemaLocation="also-not.xsd"/></definitions>`;
    expect(extractReferences(xml)).toEqual([]);
  });
});

describe('resolveReferenceUrl', () => {
  it('resolves a relative reference against the parent URL', () => {
    expect(resolveReferenceUrl('http://example.com/dir/service.wsdl', 'types.xsd')).toBe(
      'http://example.com/dir/types.xsd',
    );
  });

  it('passes through an absolute reference unchanged in origin', () => {
    expect(resolveReferenceUrl('http://example.com/dir/service.wsdl', 'https://other.com/x.xsd')).toBe(
      'https://other.com/x.xsd',
    );
  });

  it('resolves a root-relative reference', () => {
    expect(resolveReferenceUrl('http://example.com/dir/service.wsdl', '/root.xsd')).toBe('http://example.com/root.xsd');
  });
});

describe('deriveFilename', () => {
  it('derives a filename from the URL path', () => {
    expect(deriveFilename('http://example.com/dir/types.xsd')).toBe('types.xsd');
  });

  it('strips query strings', () => {
    expect(deriveFilename('http://example.com/dir/types.xsd?v=1')).toBe('types.xsd');
  });

  it('de-duplicates by appending a suffix when the name is already taken', () => {
    const used = new Set(['types.xsd']);
    expect(deriveFilename('http://other.com/other/types.xsd', used)).toBe('types-2.xsd');
  });

  it('keeps incrementing the suffix until a free name is found', () => {
    const used = new Set(['types.xsd', 'types-2.xsd']);
    expect(deriveFilename('http://other.com/other/types.xsd', used)).toBe('types-3.xsd');
  });
});
