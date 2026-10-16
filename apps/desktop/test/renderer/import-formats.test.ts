import { describe, expect, it } from 'vitest';
import { IMPORT_FORMATS, importFormatRow } from '../../src/renderer/features/explorer/import-formats.js';

describe('import formats table', () => {
  it('offers the formats in the picker order', () => {
    expect(IMPORT_FORMATS.map((row) => row.kind)).toEqual([
      'openapi',
      'asyncapi',
      'postman',
      'postman-v3',
      'postman-environment',
      'postman-globals',
      'har',
      'http-file',
      'http-env',
      'opencollection',
      'wsdl',
      'proto',
      'legacy-soap-project',
    ]);
  });

  it('keeps each format its default name', () => {
    const names = Object.fromEntries(IMPORT_FORMATS.map((row) => [row.kind, row.defaultName]));
    expect(names).toEqual({
      openapi: 'Imported API',
      asyncapi: 'Imported API',
      postman: 'Imported Collection',
      'postman-v3': 'Imported collection',
      'postman-environment': 'Imported API',
      'postman-globals': 'Imported API',
      har: 'Imported traffic',
      'http-file': 'Imported requests',
      'http-env': 'Imported API',
      opencollection: 'Imported collection',
      wsdl: 'Imported service',
      proto: 'Imported gRPC API',
      'legacy-soap-project': 'Imported API',
    });
    expect(importFormatRow('unknown').defaultName).toBe('Imported service');
  });

  it('keeps the workspace-only formats, the file-first ones and the ones with no URL tab', () => {
    const where = (test: (row: (typeof IMPORT_FORMATS)[number]) => boolean): string[] =>
      IMPORT_FORMATS.filter(test).map((row) => row.kind);
    expect(where((row) => row.workspaceOnly)).toEqual(['postman-environment', 'postman-globals', 'http-env']);
    expect(where((row) => row.fileFirst)).toEqual([
      'postman',
      'postman-v3',
      'postman-environment',
      'postman-globals',
      'har',
      'http-file',
      'http-env',
      'opencollection',
      'legacy-soap-project',
    ]);
    expect(where((row) => !row.tabs.includes('url'))).toEqual([
      'postman-v3',
      'postman-environment',
      'postman-globals',
      'har',
      'http-file',
      'http-env',
      'opencollection',
    ]);
    expect(where((row) => row.folder)).toEqual(['postman-v3']);
  });

  it('keeps each picker its filters and title', () => {
    expect(importFormatRow('postman').fileFilters).toEqual([{ name: 'Postman Collection', extensions: ['json'] }]);
    expect(importFormatRow('http-file').fileFilters).toEqual([{ name: '.http file', extensions: ['http', 'rest'] }]);
    expect(importFormatRow('postman-globals')).toMatchObject({
      fileFilters: [{ name: 'Postman export', extensions: ['json'] }],
      pickerTitle: 'Import Postman Globals',
    });
    expect(importFormatRow('postman-v3').pickerTitle).toBe('Import Collection Definition');
    expect(importFormatRow('wsdl')).toMatchObject({ pickerTitle: 'Import Definition', dialogTitle: 'Import WSDL' });
    expect(importFormatRow('unknown').fileFilters[0]?.extensions).toEqual(['json', 'yaml', 'yml', 'wsdl', 'xml']);
  });
});
