import { describe, expect, it } from 'vitest';
import { detectSnapshotFormat } from '../../../src/snapshot/format.js';

describe('detectSnapshotFormat', () => {
  it('recognises a content type containing "json"', () => {
    expect(detectSnapshotFormat('irrelevant', 'application/vnd.api+json')).toBe('json');
  });

  it('recognises a content type containing "xml"', () => {
    expect(detectSnapshotFormat('irrelevant', 'application/soap+xml')).toBe('xml');
  });

  it('falls back to the body when the content type names neither', () => {
    expect(detectSnapshotFormat('{"a":1}', 'text/plain')).toBe('json');
  });

  it('detects JSON from a leading "{" when no content type is given', () => {
    expect(detectSnapshotFormat('  {"a":1}')).toBe('json');
  });

  it('detects JSON from a leading "["', () => {
    expect(detectSnapshotFormat('[1,2,3]')).toBe('json');
  });

  it('detects XML from a leading "<"', () => {
    expect(detectSnapshotFormat('<root/>')).toBe('xml');
  });

  it('falls back to text for anything else', () => {
    expect(detectSnapshotFormat('plain body')).toBe('text');
  });

  it('prefers the content type over the body', () => {
    expect(detectSnapshotFormat('<root/>', 'application/json')).toBe('json');
  });
});
