/**
 * The body tab's own logic: what content type each kind implies, and what *Format* does.
 *
 * Formatting is the case worth pinning. A body that does not parse must never be silently rewritten
 * — the user would lose what they typed — so it comes back as an error the tab can report.
 */
import { describe, expect, it, vi } from 'vitest';

// The body tab imports the Monaco wrapper for its raw editor; the real module pulls in the whole
// bundle, which jsdom cannot load.
vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
import { formatRawBody } from '../../src/renderer/features/rest-editor/body-tab.js';
import { computedContentType } from '../../src/renderer/features/rest-editor/headers-tab.js';

describe('formatRawBody', () => {
  it('pretty-prints JSON at the indent the editor uses', () => {
    expect(formatRawBody('{"a":1}', 'json', 2)).toEqual({ text: '{\n  "a": 1\n}' });
  });

  it('reports invalid JSON rather than rewriting it', () => {
    const result = formatRawBody('{"a":', 'json', 2);
    expect('error' in result).toBe(true);
  });

  it('pretty-prints XML through the engine formatter', () => {
    const result = formatRawBody('<a><b/></a>', 'xml', 2);
    expect('text' in result && result.text).toContain('\n');
  });

  it('reports XML it cannot reformat safely', () => {
    const result = formatRawBody('<a><b></a>', 'xml', 2);
    expect('error' in result).toBe(true);
  });

  it('leaves a language with no one right shape alone', () => {
    expect(formatRawBody('hello  world', 'text', 2)).toEqual({ text: 'hello  world' });
  });
});

describe('computedContentType', () => {
  it('names the type each kind sends', () => {
    expect(computedContentType({ kind: 'none' })).toBeUndefined();
    expect(computedContentType({ kind: 'raw', language: 'json', text: '' })).toBe('application/json');
    expect(computedContentType({ kind: 'raw', language: 'xml', text: '' })).toBe('application/xml');
    expect(computedContentType({ kind: 'form', fields: [] })).toBe('application/x-www-form-urlencoded');
    expect(computedContentType({ kind: 'multipart', parts: [] })).toContain('multipart/form-data');
    expect(
      computedContentType({ kind: 'binary', source: { kind: 'path', path: '/x' }, contentType: 'image/png' }),
    ).toBe('image/png');
  });

  it('prefers a content type the raw body carries of its own', () => {
    expect(
      computedContentType({ kind: 'raw', language: 'json', text: '', contentType: 'application/merge-patch+json' }),
    ).toBe('application/merge-patch+json');
  });
});
