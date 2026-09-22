import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectImportFormat, stripLeadingProtoComments } from '../../src/import-detect.js';

describe('detectImportFormat', () => {
  it('detects WSDL XML from text with definitions', () => {
    const wsdl = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" name="Calculator" targetNamespace="http://tempuri.org/">
  <wsdl:message name="AddRequest" />
</wsdl:definitions>`;

    const detected = detectImportFormat({ text: wsdl });
    expect(detected.kind).toBe('wsdl');
    expect(detected.confidence).toBe('definite');
  });

  it('detects WSDL from filename or URL', () => {
    expect(detectImportFormat({ filename: 'service.wsdl' })).toEqual({
      kind: 'wsdl',
      label: 'WSDL / SOAP',
      confidence: 'probable',
    });
    expect(detectImportFormat({ url: 'https://example.com/api?wsdl' })).toEqual({
      kind: 'wsdl',
      label: 'WSDL / SOAP',
      confidence: 'probable',
    });
  });

  it('detects OpenAPI 3.x from JSON text', () => {
    const oasJson = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Petstore', version: '1.0' },
      paths: {},
    });

    const detected = detectImportFormat({ text: oasJson });
    expect(detected.kind).toBe('openapi');
    expect(detected.label).toBe('OpenAPI 3.1.0');
    expect(detected.confidence).toBe('definite');
  });

  it('detects OpenAPI 3.x from YAML text', () => {
    const oasYaml = `
openapi: 3.2.0
info:
  title: OAS 3.2 Petstore
  version: 1.0.0
paths: {}
`;

    const detected = detectImportFormat({ text: oasYaml });
    expect(detected.kind).toBe('openapi');
    expect(detected.label).toBe('OpenAPI 3.2.0');
    expect(detected.confidence).toBe('definite');
  });

  it('detects Swagger 2.0 from JSON text', () => {
    const swaggerJson = JSON.stringify({
      swagger: '2.0',
      info: { title: 'Old API', version: '1.0' },
      paths: {},
    });

    const detected = detectImportFormat({ text: swaggerJson });
    expect(detected.kind).toBe('openapi');
    expect(detected.label).toBe('Swagger 2.0');
    expect(detected.confidence).toBe('definite');
  });

  it('detects Swagger 1.2 from JSON text with swaggerVersion', () => {
    const swaggerJson = JSON.stringify({
      swaggerVersion: '1.2',
      basePath: 'http://example.com/api',
      apis: [],
    });

    const detected = detectImportFormat({ text: swaggerJson });
    expect(detected.kind).toBe('openapi');
    expect(detected.label).toBe('Swagger 1.2');
    expect(detected.confidence).toBe('definite');
  });

  it('detects Swagger 1.1 from JSON text with swaggerVersion', () => {
    const swaggerJson = JSON.stringify({
      swaggerVersion: '1.1',
      basePath: 'http://example.com/api',
      apis: [],
    });

    const detected = detectImportFormat({ text: swaggerJson });
    expect(detected.kind).toBe('openapi');
    expect(detected.label).toBe('Swagger 1.1');
    expect(detected.confidence).toBe('definite');
  });

  it('detects Postman Collection v2.1 from JSON text', () => {
    const postmanJson = JSON.stringify({
      info: {
        _postman_id: '1234',
        name: 'My Collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [],
    });

    const detected = detectImportFormat({ text: postmanJson });
    expect(detected.kind).toBe('postman');
    expect(detected.label).toBe('Postman Collection v2.1');
    expect(detected.confidence).toBe('definite');
  });

  it('detects Postman Collection from filename', () => {
    const detected = detectImportFormat({ filename: 'my_api.postman_collection.json' });
    expect(detected.kind).toBe('postman');
    expect(detected.confidence).toBe('probable');
  });

  it('falls back to unknown when text or filename has no recognizable signals', () => {
    const detected = detectImportFormat({ text: 'Hello World', filename: 'notes.txt' });
    expect(detected.kind).toBe('unknown');
    expect(detected.confidence).toBe('unknown');
  });

  it('treats empty string filename as absent and falls back to URL (3.13)', () => {
    const detected = detectImportFormat({ filename: '   ', url: 'https://example.com/api/openapi.yaml' });
    expect(detected.kind).toBe('openapi');
    expect(detected.confidence).toBe('probable');
  });

  it('reports probable confidence on regex-only text fallback (3.12)', () => {
    // Unparseable JSON/YAML with swagger: 2.0 indicator
    const partialSnippet = '!!invalid-syntax\n  swagger: 2.0\n';
    const detected = detectImportFormat({ text: partialSnippet });
    expect(detected.kind).toBe('openapi');
    expect(detected.label).toBe('Swagger');
    expect(detected.confidence).toBe('probable');
  });

  it('keeps no Node-only imports in import-detect.ts for browser safety (1.1)', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const filePath = path.resolve(import.meta.dirname, '../../src/import-detect.ts');
    const content = await fs.readFile(filePath, 'utf8');

    // Matches `import ... from '...'`
    const importRegex = /import\s+(?:(?:[\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]/g;
    const imports: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      imports.push(match[1]!);
    }

    for (const specifier of imports) {
      expect(specifier.startsWith('node:')).toBe(false);
      expect(['fs', 'path', 'os', 'child_process', 'crypto', 'net', 'http', 'https']).not.toContain(specifier);
    }
  });

  it('detects a .proto file from its syntax statement, its keywords, or its file name', () => {
    expect(detectImportFormat({ text: 'syntax = "proto3";\npackage a;\nmessage A {}' })).toEqual({
      kind: 'proto',
      label: 'Protocol Buffers (proto3)',
      confidence: 'definite',
    });
    expect(detectImportFormat({ text: '// licence\n\nsyntax = "proto2";\nmessage A {}' }).label).toBe(
      'Protocol Buffers (proto2)',
    );
    expect(detectImportFormat({ text: 'edition = "2023";\nmessage A {}' }).label).toBe('Protocol Buffers (editions)');
    expect(detectImportFormat({ text: 'package a.b;\nservice S { rpc M (A) returns (B); }' })).toMatchObject({
      kind: 'proto',
      confidence: 'probable',
    });
    expect(detectImportFormat({ filename: 'greeter.proto' })).toMatchObject({ kind: 'proto', confidence: 'probable' });
    expect(detectImportFormat({ url: 'https://example.com/api/greeter.proto' }).kind).toBe('proto');
    expect(detectImportFormat({ text: '{"openapi": "3.1.0"}' }).kind).toBe('openapi');
  });
});

describe('stripLeadingProtoComments', () => {
  it('drops the comments and whitespace a .proto opens with, leaving its first statement', () => {
    expect(stripLeadingProtoComments('// a\n/* b */\n  syntax = "proto3";')).toBe('syntax = "proto3";');
    expect(stripLeadingProtoComments('syntax = "proto3";')).toBe('syntax = "proto3";');
  });

  it('is empty when the text is nothing but an unterminated comment', () => {
    expect(stripLeadingProtoComments('/* never closed')).toBe('');
    expect(stripLeadingProtoComments('// no newline')).toBe('');
  });

  it('runs in linear time on the repetition CodeQL flagged', () => {
    const started = performance.now();
    expect(stripLeadingProtoComments(`/*${'*//*'.repeat(20_000)}`)).toBe('');
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('detectImportFormat: legacy SOAP projects', () => {
  const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/legacy-soap-project');

  it('recognises a legacy project even though it carries WSDL text inside it', () => {
    const text = readFileSync(resolve(FIXTURES, 'full.xml'), 'utf8');
    expect(detectImportFormat({ text })).toEqual({
      kind: 'legacy-soap-project',
      label: 'Legacy SOAP project',
      confidence: 'definite',
    });
  });

  it('still detects a plain WSDL, and never guesses a legacy project from an .xml file name', () => {
    const wsdl = readFileSync(resolve(FIXTURES, '../wsdl/crafted/nested-imports/service.wsdl'), 'utf8');
    expect(detectImportFormat({ text: wsdl }).kind).toBe('wsdl');
    expect(detectImportFormat({ filename: 'project.xml' }).kind).toBe('unknown');
  });
});

describe('detectImportFormat: AsyncAPI', () => {
  it('is definite on the asyncapi key, in JSON and YAML', () => {
    expect(detectImportFormat({ text: '{"asyncapi":"2.6.0","info":{}}' })).toEqual({
      kind: 'asyncapi',
      label: 'AsyncAPI 2.6.0',
      confidence: 'definite',
    });
    expect(detectImportFormat({ text: 'asyncapi: 3.0.0\nchannels: {}', filename: 'x.yaml' }).kind).toBe('asyncapi');
  });

  it('is probable from a file name that says so, before the YAML fallback', () => {
    expect(detectImportFormat({ filename: 'chat.asyncapi.yaml' })).toEqual({
      kind: 'asyncapi',
      label: 'AsyncAPI',
      confidence: 'probable',
    });
    expect(detectImportFormat({ filename: 'chat.yaml' }).kind).toBe('openapi');
  });
});
