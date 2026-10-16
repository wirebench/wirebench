/**
 * The counts on the REST tabs that hold rows (#559): only rows that are sent count, and an empty
 * table shows no count at all, as the Assertions tab does.
 */
import { describe, expect, it } from 'vitest';
import { bodyBadge, responseHeadersBadge, rowsBadge } from '../../src/renderer/features/rest-editor/tab-counts.js';

describe('rowsBadge', () => {
  it('counts the switched-on, named rows', () => {
    expect(
      rowsBadge([
        { name: 'a', enabled: true },
        { name: 'b', enabled: false },
        { name: '', enabled: true },
        { name: 'c', enabled: true },
      ]),
    ).toBe('2');
  });

  it('shows nothing for an empty table', () => {
    expect(rowsBadge([])).toBeUndefined();
    expect(rowsBadge([{ name: 'off', enabled: false }])).toBeUndefined();
  });
});

describe('responseHeadersBadge', () => {
  it('counts the headers as they came off the wire, a repeat twice', () => {
    expect(
      responseHeadersBadge({
        headers: { 'set-cookie': 'a, b' },
        rawHeaders: [
          ['Set-Cookie', 'a'],
          ['Set-Cookie', 'b'],
        ],
      }),
    ).toBe('2');
  });

  it('falls back to the joined map, and shows nothing for none', () => {
    expect(responseHeadersBadge({ headers: { a: '1', b: '2', c: '3' } })).toBe('3');
    expect(responseHeadersBadge({ headers: {} })).toBeUndefined();
  });
});

describe('bodyBadge (#637)', () => {
  it('dots a body that would be sent', () => {
    expect(bodyBadge({ kind: 'raw', language: 'json', text: '{"a":1}' })).toBe('●');
    expect(bodyBadge({ kind: 'form', fields: [{ name: 'a', value: '1', enabled: true }] })).toBe('●');
    expect(bodyBadge({ kind: 'multipart', parts: [{ kind: 'text', name: 'a', value: '1', enabled: true }] })).toBe('●');
    expect(bodyBadge({ kind: 'binary', source: { kind: 'path', path: '/tmp/a.bin' }, contentType: 'x/y' })).toBe('●');
    expect(bodyBadge({ kind: 'graphql', query: '{ pets { id } }', variables: '' })).toBe('●');
  });

  it('shows nothing for no body, or one with nothing in it', () => {
    expect(bodyBadge({ kind: 'none' })).toBeUndefined();
    expect(bodyBadge({ kind: 'raw', language: 'json', text: '  \n' })).toBeUndefined();
    expect(bodyBadge({ kind: 'form', fields: [{ name: 'a', value: '1', enabled: false }] })).toBeUndefined();
    expect(bodyBadge({ kind: 'multipart', parts: [] })).toBeUndefined();
    expect(bodyBadge({ kind: 'binary', source: { kind: 'path', path: '' }, contentType: 'x/y' })).toBeUndefined();
    expect(bodyBadge({ kind: 'graphql', query: '', variables: '' })).toBeUndefined();
  });
});
