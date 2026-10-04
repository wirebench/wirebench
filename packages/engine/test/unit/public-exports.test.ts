// packages/engine/test/unit/public-exports.test.ts
/**
 * The public surface of `@wirebench/engine` in 3.0 (spec §8): what was added, what was renamed and
 * what was removed. The type names are guarded by `public-exports.types.ts`, which `tsc -b` checks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as engine from '../../src/index.js';

const names = new Set(Object.keys(engine));
const valueOf = (name: string): unknown => Reflect.get(engine, name);

const ADDED = [
  'wsSubject',
  'checkRequestAssertions',
  'BUILTIN_PROTOCOLS',
  'createBuiltinRegistry',
  'createFeatureSet',
  'createProtocolRegistry',
  'defineProtocol',
  'extraContainersOf',
  'takenContainerSlugs',
  'unsupportedOf',
  'grpcStatusNames',
  'rewriteMustache',
  'ReportBuilder',
  'uniqueName',
  'formatImportReport',
  'VariableSetBuilder',
  'credentialLookingNames',
  'warnCredentialLookingNames',
  'importedScriptPath',
] as const;

/** 2.x name, 3.0 name. */
const RENAMED: Array<[string, string]> = [
  ['importDefinition', 'importWsdl'],
  ['summarizeOperations', 'summarizeSoapOperations'],
  ['generateRequest', 'generateSoapRequest'],
  ['generateEmptyRequest', 'generateEmptySoapRequest'],
  ['toSendInput', 'toSoapSendInput'],
];

const REMOVED = ['prepareSend', 'assertSupportedKind', 'apiKindOf', 'scriptTypesFor'] as const;

/** A sample of what spec §8 lists as unchanged. */
const UNCHANGED = [
  'sendSoapRequest',
  'sendRest',
  'callGrpc',
  'soapResponseSubject',
  'restSubject',
  'grpcSubject',
  'runRequests',
  'createRunSender',
  'selectRequests',
  'loadProject',
  'saveProject',
  'toRestSendInput',
  'toGrpcSendInput',
] as const;

/** Values three core files re-exported until 3.0; `index.ts` now exports each from the module that declares it. */
const REHOMED = [
  'apiFileSchema',
  'applyGrpcSnapshot',
  'applyRestSnapshot',
  'applySoapSnapshot',
  'grpcApiFileSchema',
  'grpcMessageTypes',
  'grpcMethodKindSchema',
  'grpcRequestFileSchema',
  'grpcRequestSnapshot',
  'grpcResponseSnapshot',
  'grpcScriptTypes',
  'interfaceFileSchema',
  'loadOpenApiDocument',
  'projectSoapBody',
  'qnameFromClark',
  'replaceSoapBody',
  'requestFileSchema',
  'restBodySchema',
  'restOperationFor',
  'restRequestFileSchema',
  'restRequestSnapshot',
  'restResponseSnapshot',
  'restScriptTypes',
  'soapOperationElements',
  'soapRequestSnapshot',
  'soapResponseSnapshot',
  'soapScriptTypes',
] as const;

/** File under `src/`, and the declarations in it that carry `@internal` as their JSDoc's last line. */
const INTERNAL: Readonly<Record<string, readonly string[]>> = {
  'protocol/features.ts': ['FeatureDescriptor', 'WhyDisabled', 'FeatureSet', 'createFeatureSet'],
  'protocol/module.ts': [
    'ContainerDir',
    'ContainerBase',
    'LoadContext',
    'ProtocolStorage',
    'SelectedBase',
    'RunGroup',
    'RunScope',
    'ScriptedSend',
    'ProtocolRun',
    'RequestSnapshotBase',
    'ResponseSnapshotBase',
    'SnapshotFacts',
    'ProtocolScripting',
    'ProtocolModule',
    'defineProtocol',
  ],
  'protocol/registry.ts': ['ProtocolRegistry', 'ProtocolRegistryOptions', 'createProtocolRegistry'],
  'grpc/status.ts': ['grpcStatusNames'],
  'assert/model.ts': ['StatusNames'],
  'protocols.ts': ['BUILTIN_PROTOCOLS', 'createBuiltinRegistry'],
  'project/model.ts': ['UnsupportedContainer', 'unsupportedOf', 'extraContainersOf', 'takenContainerSlugs'],
};

/** File under `src/`, and the fields in it that carry the tag. */
const INTERNAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'project/model.ts': ['extraContainers', 'unsupported'],
  'assert/model.ts': ['statusNames'],
};

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8').replaceAll('\r\n', '\n');
}

describe('the public exports of 3.0', () => {
  it.each(ADDED)('exports %s', (name) => {
    expect(valueOf(name)).toBeDefined();
  });

  it.each(RENAMED)('exports %s under its 3.0 name only', (before, after) => {
    expect(names.has(before)).toBe(false);
    expect(typeof valueOf(after)).toBe('function');
  });

  it.each(REMOVED)('no longer exports %s', (name) => {
    expect(names.has(name)).toBe(false);
  });

  it.each(UNCHANGED)('still exports %s', (name) => {
    expect(typeof valueOf(name)).toBe('function');
  });

  it.each(REHOMED)('still exports %s, from the module that declares it', (name) => {
    expect(valueOf(name)).toBeDefined();
  });

  it('composes the four built-in protocols, every one enabled', () => {
    expect(engine.BUILTIN_PROTOCOLS.map((module) => module.kind).sort()).toEqual(['grpc', 'rest', 'soap', 'websocket']);
    const registry = engine.createBuiltinRegistry();
    expect(registry.modules.map((module) => module.kind).sort()).toEqual(['grpc', 'rest', 'soap', 'websocket']);
    expect(registry.features.isEnabled('scripts')).toBe(true);
  });

  it('tells an enabled kind from a disabled and an unknown one', () => {
    const registry = engine.createBuiltinRegistry({ grpc: false });
    expect(registry.status('soap')).toBe('enabled');
    expect(registry.status('grpc')).toBe('disabled');
    expect(registry.status('graphql')).toBe('unknown');
  });
});

describe('the module API is tagged @internal', () => {
  for (const [file, declarations] of Object.entries(INTERNAL)) {
    const text = source(file);
    it.each(declarations)(`${file}: %s`, (name) => {
      const tagged = new RegExp(`@internal[^\\n]*\\n \\*/\\nexport (?:interface|type|function|const) ${name}\\b`);
      expect(tagged.test(text)).toBe(true);
    });
  }

  for (const [file, fields] of Object.entries(INTERNAL_FIELDS)) {
    const text = source(file);
    it.each(fields)(`${file}: the field %s`, (name) => {
      const tagged = new RegExp(`@internal[^\\n]*\\n\\s*\\*/\\n\\s*readonly ${name}\\??:`);
      expect(tagged.test(text)).toBe(true);
    });
  }
});
