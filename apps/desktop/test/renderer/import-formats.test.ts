import { describe, expect, it } from 'vitest';
import type { ImportFormatKind } from '@wirebench/engine/detect';
import { IMPORT_FORMATS, importFormatRow } from '../../src/renderer/features/explorer/import-formats.js';

const ALL_TABS = ['url', 'file', 'paste'] as const;
const NO_URL_TABS = ['file', 'paste'] as const;

const CLIENT_KINDS: readonly ImportFormatKind[] = [
  'insomnia',
  'insomnia-environment',
  'bruno',
  'hoppscotch',
  'hoppscotch-environment',
  'thunder-client',
  'thunder-client-environment',
];

describe('IMPORT_FORMATS', () => {
  it('every existing format keeps its label, tabs, default name, picker and filters', () => {
    const json = (name: string) => [{ name, extensions: ['json'] }];
    const withAll = (name: string, extensions: string[]) => [
      { name, extensions },
      { name: 'All Files', extensions: ['*'] },
    ];
    const expected: Record<string, unknown> = {
      openapi: {
        label: 'OpenAPI / Swagger',
        tabs: ALL_TABS,
        defaultName: 'Imported API',
        workspaceOnly: false,
        fileFilters: withAll('OpenAPI Specification', ['json', 'yaml', 'yml']),
      },
      asyncapi: {
        label: 'AsyncAPI (WebSocket)',
        tabs: ALL_TABS,
        defaultName: 'Imported API',
        workspaceOnly: false,
        fileFilters: withAll('AsyncAPI Document', ['json', 'yaml', 'yml']),
      },
      postman: {
        label: 'Postman Collection',
        tabs: ALL_TABS,
        defaultName: 'Imported Collection',
        workspaceOnly: false,
        fileFilters: json('Postman Collection'),
      },
      'postman-v3': {
        label: 'Postman Collection v3 (folder)',
        tabs: NO_URL_TABS,
        defaultName: 'Imported collection',
        workspaceOnly: false,
        fileFilters: [{ name: 'Collection definition (.resources/definition.yaml)', extensions: ['yaml', 'yml'] }],
      },
      'postman-environment': {
        label: 'Postman environment',
        tabs: NO_URL_TABS,
        defaultName: 'Imported API',
        workspaceOnly: true,
        fileFilters: json('Postman export'),
      },
      'postman-globals': {
        label: 'Postman globals',
        tabs: NO_URL_TABS,
        defaultName: 'Imported API',
        workspaceOnly: true,
        fileFilters: json('Postman export'),
      },
      har: {
        label: 'HAR (recorded traffic)',
        tabs: NO_URL_TABS,
        defaultName: 'Imported traffic',
        workspaceOnly: false,
        fileFilters: [{ name: 'HAR', extensions: ['har', 'json'] }],
      },
      'http-file': {
        label: '.http file',
        tabs: NO_URL_TABS,
        defaultName: 'Imported requests',
        workspaceOnly: false,
        fileFilters: [{ name: '.http file', extensions: ['http', 'rest'] }],
      },
      'http-env': {
        label: 'HTTP client environment file',
        tabs: NO_URL_TABS,
        defaultName: 'Imported API',
        workspaceOnly: true,
        fileFilters: json('HTTP client environment file'),
      },
      opencollection: {
        label: 'OpenCollection',
        tabs: NO_URL_TABS,
        defaultName: 'Imported collection',
        workspaceOnly: false,
        fileFilters: [{ name: 'OpenCollection', extensions: ['yml', 'yaml'] }],
      },
      wsdl: {
        label: 'WSDL (SOAP)',
        tabs: ALL_TABS,
        defaultName: 'Imported service',
        workspaceOnly: false,
        fileFilters: withAll('API Definitions (*.json, *.yaml, *.yml, *.wsdl, *.xml)', [
          'json',
          'yaml',
          'yml',
          'wsdl',
          'xml',
        ]),
      },
      proto: {
        label: 'Protocol Buffers (gRPC)',
        tabs: [...ALL_TABS, 'server'],
        defaultName: 'Imported gRPC API',
        workspaceOnly: false,
        fileFilters: withAll('Protocol Buffers', ['proto']),
      },
      'legacy-soap-project': {
        label: 'Legacy SOAP project',
        tabs: ALL_TABS,
        defaultName: 'Imported API',
        workspaceOnly: false,
        fileFilters: withAll('Legacy SOAP project', ['xml']),
      },
      unknown: {
        label: 'Unknown',
        tabs: ALL_TABS,
        defaultName: 'Imported service',
        workspaceOnly: false,
        fileFilters: withAll('API Definitions (*.json, *.yaml, *.yml, *.wsdl, *.xml)', [
          'json',
          'yaml',
          'yml',
          'wsdl',
          'xml',
        ]),
      },
    };
    for (const [kind, want] of Object.entries(expected)) {
      const row = importFormatRow(kind as ImportFormatKind);
      const { label, tabs, defaultName, workspaceOnly, fileFilters } = row;
      expect({ label, tabs, defaultName, workspaceOnly, fileFilters }, kind).toEqual(want);
      expect(row.available, kind).toBe(true);
    }
  });

  it('has exactly one row per format kind', () => {
    const kinds = IMPORT_FORMATS.map((row) => row.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(21);
  });

  it('every client format is unavailable until its importer is wired', () => {
    for (const kind of CLIENT_KINDS) {
      expect(importFormatRow(kind).available, kind).toBe(false);
    }
  });

  it('the client environment formats land in the workspace', () => {
    for (const kind of CLIENT_KINDS.filter((item) => item.endsWith('-environment'))) {
      expect(importFormatRow(kind).workspaceOnly, kind).toBe(true);
    }
    expect(importFormatRow('bruno').workspaceOnly).toBe(false);
  });
});
