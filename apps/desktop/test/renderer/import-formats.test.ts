import type { ImportFormatKind } from '@wirebench/engine/detect';
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
      'insomnia',
      'insomnia-environment',
      'hoppscotch',
      'hoppscotch-environment',
      'bruno',
      'thunder-client',
      'thunder-client-environment',
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
      insomnia: 'Imported collection',
      'insomnia-environment': 'Imported API',
      hoppscotch: 'Imported collection',
      'hoppscotch-environment': 'Imported API',
      bruno: 'Imported collection',
      'thunder-client': 'Imported collection',
      'thunder-client-environment': 'Imported API',
      wsdl: 'Imported service',
      proto: 'Imported gRPC API',
      'legacy-soap-project': 'Imported API',
    });
    expect(importFormatRow('unknown').defaultName).toBe('Imported service');
  });

  it('keeps the workspace-only formats, the file-first ones and the ones with no URL tab', () => {
    const where = (test: (row: (typeof IMPORT_FORMATS)[number]) => boolean): string[] =>
      IMPORT_FORMATS.filter(test).map((row) => row.kind);
    expect(where((row) => row.workspaceOnly)).toEqual([
      'postman-environment',
      'postman-globals',
      'http-env',
      'insomnia-environment',
      'hoppscotch-environment',
      'thunder-client-environment',
    ]);
    expect(where((row) => row.fileFirst)).toEqual([
      'postman',
      'postman-v3',
      'postman-environment',
      'postman-globals',
      'har',
      'http-file',
      'http-env',
      'opencollection',
      'insomnia',
      'insomnia-environment',
      'hoppscotch',
      'hoppscotch-environment',
      'bruno',
      'thunder-client',
      'thunder-client-environment',
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
      'insomnia',
      'insomnia-environment',
      'hoppscotch',
      'hoppscotch-environment',
      'bruno',
      'thunder-client',
      'thunder-client-environment',
    ]);
    expect(where((row) => row.folder)).toEqual(['postman-v3', 'bruno', 'thunder-client']);
  });

  it('keeps each picker its filters and title', () => {
    expect(importFormatRow('postman').fileFilters).toEqual([{ name: 'Postman Collection', extensions: ['json'] }]);
    expect(importFormatRow('http-file').fileFilters).toEqual([{ name: '.http file', extensions: ['http', 'rest'] }]);
    expect(importFormatRow('postman-globals')).toMatchObject({
      fileFilters: [{ name: 'Postman export', extensions: ['json'] }],
      pickerTitle: 'Import Postman Globals',
    });
    expect(importFormatRow('insomnia').fileFilters).toEqual([
      { name: 'Insomnia export', extensions: ['json', 'yaml', 'yml'] },
    ]);
    expect(importFormatRow('bruno')).toMatchObject({
      tabs: ['file', 'paste'],
      folder: true,
      fileFilters: [{ name: 'Bruno collection (bruno.json) or export', extensions: ['json'] }],
    });
    expect(importFormatRow('postman-v3').pickerTitle).toBe('Import Collection Definition');
    expect(importFormatRow('wsdl')).toMatchObject({ pickerTitle: 'Import Definition', dialogTitle: 'Import WSDL' });
    expect(importFormatRow('unknown').fileFilters[0]?.extensions).toEqual(['json', 'yaml', 'yml', 'wsdl', 'xml']);
  });

  it('places every format kind: a row, not imported yet, or the unknown fallback', () => {
    // `satisfies` makes a new ImportFormatKind fail to compile here until it is placed.
    const placed = {
      openapi: 'row',
      asyncapi: 'row',
      postman: 'row',
      'postman-v3': 'row',
      'postman-environment': 'row',
      'postman-globals': 'row',
      har: 'row',
      'http-file': 'row',
      'http-env': 'row',
      opencollection: 'row',
      insomnia: 'row',
      'insomnia-environment': 'row',
      bruno: 'row',
      hoppscotch: 'row',
      'hoppscotch-environment': 'row',
      'thunder-client': 'not-yet',
      'thunder-client-environment': 'not-yet',
      wsdl: 'row',
      proto: 'row',
      'legacy-soap-project': 'row',
      unknown: 'fallback',
    } satisfies Record<ImportFormatKind, 'row' | 'not-yet' | 'fallback'>;
    const kinds = Object.keys(placed) as ImportFormatKind[];
    expect(IMPORT_FORMATS.map((row) => row.kind).sort()).toEqual(kinds.filter((k) => placed[k] === 'row').sort());
    for (const kind of kinds.filter((k) => placed[k] !== 'row')) {
      expect(importFormatRow(kind).kind, kind).toBe('unknown');
    }
  });
});
