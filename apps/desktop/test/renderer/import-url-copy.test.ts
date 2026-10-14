import { describe, expect, it } from 'vitest';
import { importUrlCopy } from '../../src/renderer/features/explorer/import-url-copy.js';

describe('importUrlCopy', () => {
  it('names no format under Auto-detect', () => {
    expect(importUrlCopy('auto')).toEqual({
      label: 'Definition URL or file',
      placeholder: 'https://example.test/openapi.json',
    });
  });

  it('says WSDL only for WSDL', () => {
    expect(importUrlCopy('wsdl').label).toBe('WSDL URL');
    for (const format of ['auto', 'openapi', 'asyncapi', 'postman', 'proto', 'legacy-soap-project'] as const) {
      expect(importUrlCopy(format).label).not.toContain('WSDL');
      expect(importUrlCopy(format).placeholder).not.toContain('wsdl');
    }
  });

  it('labels OpenAPI as a definition and a collection as a collection', () => {
    expect(importUrlCopy('openapi').label).toBe('Definition URL or file');
    expect(importUrlCopy('postman')).toEqual({
      label: 'Collection URL',
      placeholder: 'https://example.test/collection.json',
    });
  });
});
