// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compileQuery, searchDocuments } from '../src/main/search.js';
import type { SearchDocument } from '../src/main/search.js';
import type { SearchQueryRequest } from '../src/shared/wire-types.js';

const BODY = ['<Envelope>', '  <Add>', '    <intA>7</intA>', '    <intB>7</intB>', '  </Add>', '</Envelope>'].join(
  '\n',
);

const DOCUMENTS: readonly SearchDocument[] = [
  { kind: 'request-body', text: BODY, requestId: 'req-1', requestName: 'Request 1', interfaceId: 'if-1' },
  {
    kind: 'document',
    text: '<wsdl:definitions>\n  <wsdl:operation name="Add"/>\n</wsdl:definitions>',
    location: 'a.wsdl',
  },
];

function query(overrides: Partial<SearchQueryRequest> = {}): SearchQueryRequest {
  return {
    query: 'Add',
    regex: false,
    caseSensitive: false,
    scopes: { requestBodies: true, headers: true, definitions: true },
    ...overrides,
  };
}

describe('compileQuery', () => {
  it('treats a plain query literally', () => {
    expect(compileQuery({ query: 'a.b', regex: false, caseSensitive: true }).test('axb')).toBe(false);
    expect(compileQuery({ query: 'a.b', regex: false, caseSensitive: true }).test('a.b')).toBe(true);
  });

  it('honours the regex toggle', () => {
    expect(compileQuery({ query: 'a.b', regex: true, caseSensitive: true }).test('axb')).toBe(true);
  });

  it('is case-insensitive unless asked otherwise', () => {
    expect(compileQuery({ query: 'add', regex: false, caseSensitive: false }).test('ADD')).toBe(true);
    expect(compileQuery({ query: 'add', regex: false, caseSensitive: true }).test('ADD')).toBe(false);
  });

  it('reports an invalid pattern as invalid-regex', () => {
    expect(() => compileQuery({ query: '(', regex: true, caseSensitive: false })).toThrow(
      expect.objectContaining({ code: 'invalid-regex' }),
    );
  });
});

describe('searchDocuments', () => {
  it('reports the line, column and offsets of each match', () => {
    const { matches } = searchDocuments([DOCUMENTS[0] as SearchDocument], query());

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ line: 2, column: 4, kind: 'request-body', requestName: 'Request 1' });
    expect(BODY.slice(matches[0]?.start ?? 0, matches[0]?.end ?? 0)).toBe('Add');
  });

  it('sends only the matching line, trimmed — never the document', () => {
    const { matches } = searchDocuments([DOCUMENTS[0] as SearchDocument], query());

    expect(matches[0]?.snippet).toBe('<Add>');
  });

  it('reports one match per line, not one per occurrence', () => {
    const { matches } = searchDocuments([{ kind: 'document', text: 'Add Add Add\nAdd', location: 'a' }], query());

    expect(matches.map((match) => match.line)).toEqual([1, 2]);
  });

  it('carries the document identity through', () => {
    const { matches } = searchDocuments([DOCUMENTS[1] as SearchDocument], query());

    expect(matches[0]).toMatchObject({ kind: 'document', location: 'a.wsdl', line: 2 });
  });

  it('caps the results and says it did', () => {
    const result = searchDocuments(DOCUMENTS, query({ limit: 1 }));

    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('does not report truncation when everything fit', () => {
    expect(searchDocuments(DOCUMENTS, query()).truncated).toBe(false);
  });

  it('finds nothing for a query no document contains', () => {
    expect(searchDocuments(DOCUMENTS, query({ query: 'Subtract' })).matches).toEqual([]);
  });

  it('terminates on a pattern that can match the empty string', () => {
    expect(
      searchDocuments([{ kind: 'document', text: 'aaa\nbbb', location: 'a' }], query({ query: 'a*', regex: true }))
        .matches.length,
    ).toBeGreaterThan(0);
  });

  it('truncates a very long matching line', () => {
    const long = `${'x'.repeat(500)}Add`;
    const { matches } = searchDocuments([{ kind: 'document', text: long, location: 'a' }], query());

    expect(matches[0]?.snippet.endsWith('…')).toBe(true);
    expect(matches[0]?.snippet.length).toBeLessThanOrEqual(201);
  });
});
