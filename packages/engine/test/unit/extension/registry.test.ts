import { describe, expect, it } from 'vitest';
import { createExtensionRegistry } from '#core/extension/registry';
import type { ReporterContribution } from '#core/extension/registry';
import { CODE_TARGETS, generateCode } from '#core/http/codegen/index';
import type { CodeRequest } from '#core/http/codegen/index';
import { createFeatureSet } from '#core/protocol/features';
import { BUILTIN_IMPORTERS } from '../../../src/extensions.js';
import type { BuiltinImportFormatKind } from '../../../src/import-detect.js';
import { createBuiltinRegistry } from '../../../src/protocols.js';

const request: CodeRequest = {
  method: 'POST',
  url: 'https://api.example.test/items?x=1',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  body: { kind: 'raw', text: '{"a":1}' },
  followRedirects: true,
};

const plugin = (id: string, plugin = 'acme'): ReporterContribution => ({
  id,
  title: id,
  origin: { kind: 'plugin', plugin },
  extension: '.txt',
  render: () => '',
});

describe('the built-in extension registry', () => {
  it('generates the same code as the eleven targets, in their order', () => {
    const { codeGenerators } = createBuiltinRegistry().extensions;
    expect(codeGenerators.map((entry) => entry.id)).toEqual(CODE_TARGETS.map((target) => target.id));
    for (const target of CODE_TARGETS) {
      const entry = createBuiltinRegistry().extensions.codeGenerator(target.id);
      expect(entry.title).toBe(target.label);
      expect(entry.generate(request, { indent: 3 })).toEqual(generateCode(target.id, request, { indent: 3 }));
    }
  });

  it('has the json reporter, and a host adds its own after it', () => {
    const extra = plugin('acme/summary');
    const { reporters } = createBuiltinRegistry(undefined, { reporters: [extra] }).extensions;
    expect(reporters.map((entry) => entry.id)).toEqual(['json', 'acme/summary']);
  });

  it('registers every built-in import format once', () => {
    const all: Record<BuiltinImportFormatKind, true> = {
      openapi: true,
      asyncapi: true,
      postman: true,
      'postman-v3': true,
      'postman-environment': true,
      'postman-globals': true,
      har: true,
      'http-file': true,
      'http-env': true,
      opencollection: true,
      insomnia: true,
      'insomnia-environment': true,
      bruno: true,
      hoppscotch: true,
      'hoppscotch-environment': true,
      'thunder-client': true,
      'thunder-client-environment': true,
      wsdl: true,
      proto: true,
      'legacy-soap-project': true,
    };
    expect(BUILTIN_IMPORTERS.map((entry) => entry.id).sort()).toEqual(Object.keys(all).sort());
  });

  it('leaves out an importer whose kind is off and refuses it by id', () => {
    const { extensions } = createBuiltinRegistry({ soap: false });
    expect(extensions.importers.map((entry) => entry.id)).not.toContain('wsdl');
    expect(extensions.importers.map((entry) => entry.id)).toContain('postman-environment');
    expect(() => extensions.importer('wsdl')).toThrow(expect.objectContaining({ code: 'feature-disabled' }));
  });

  it('tells an unknown id apart from one that is off', () => {
    let thrown: unknown;
    try {
      createBuiltinRegistry().extensions.reporter('xml');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'contribution-unknown', details: { known: ['json'] } });
  });
});

describe('createExtensionRegistry', () => {
  const features = createFeatureSet([], {});

  it('refuses a plugin id that its plugin does not prefix', () => {
    expect(() => createExtensionRegistry({ reporters: [plugin('other/summary')] }, features)).toThrow(/namespaced/);
    expect(() => createExtensionRegistry({ reporters: [plugin('summary')] }, features)).toThrow(/valid/);
  });

  it('refuses a built-in id with a slash, and two entries of one id', () => {
    const builtin: ReporterContribution = { ...plugin('a/b'), origin: { kind: 'builtin' } };
    expect(() => createExtensionRegistry({ reporters: [builtin] }, features)).toThrow(/valid/);
    expect(() => createExtensionRegistry({ reporters: [plugin('acme/x'), plugin('acme/x')] }, features)).toThrow(
      /two reporters/,
    );
  });
});
