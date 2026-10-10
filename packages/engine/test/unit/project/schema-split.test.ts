/**
 * The file schemas live with their protocols and are exported from there. `project/schema.ts`
 * holds the core documents, and still exports the shared pieces of `schema-parts.ts` (spec §3.2).
 */
import { describe, expect, it } from 'vitest';
import * as grpcFiles from '../../../src/grpc/files.js';
import * as parts from '../../../src/project/schema-parts.js';
import * as schema from '../../../src/project/schema.js';
import * as restFiles from '../../../src/rest/files.js';
import * as soapFiles from '../../../src/soap/files.js';
import * as wsFiles from '../../../src/ws/files.js';
import * as wssSchema from '../../../src/wss/schema.js';

type Exports = Readonly<Record<string, unknown>>;

const MOVED: readonly (readonly [string, Exports, readonly string[]])[] = [
  ['soap/files.ts', { ...soapFiles }, ['interfaceFileSchema', 'requestFileSchema']],
  ['rest/files.ts', { ...restFiles }, ['apiFileSchema', 'restBodySchema', 'restRequestFileSchema']],
  ['grpc/files.ts', { ...grpcFiles }, ['grpcApiFileSchema', 'grpcMethodKindSchema', 'grpcRequestFileSchema']],
  ['ws/files.ts', { ...wsFiles }, ['wsApiFileSchema', 'wsRequestFileSchema']],
  ['wss/schema.ts', { ...wssSchema }, ['wssEntrySchema', 'wssIssuedTokenEntrySchema', 'wssSamlTokenEntrySchema']],
  [
    'project/schema-parts.ts',
    { ...parts },
    [
      'assertSupportedKind',
      'attachmentSourceSchema',
      'authConfigSchema',
      'definitionAuthSchema',
      'endpointAuthSchema',
      'hookLinkSchema',
      'keyValueEntrySchema',
      'parseFile',
      'restFolderFileSchema',
      'scriptsSchema',
      'soapOwnerAuthSchema',
      'webhookSigningSchema',
    ],
  ],
];

const CORE = [
  'apiDefinitionCacheManifestSchema',
  'definitionCacheManifestSchema',
  'descriptorDefinitionCacheManifestSchema',
  'environmentFileSchema',
  'keystoreEntrySchema',
  'keystoresFileSchema',
  'manifestSchema',
  'protoDefinitionCacheManifestSchema',
  'webhookFolderFileSchema',
  'webhooksFileSchema',
  'wssIncomingFileSchema',
  'wssOutgoingFileSchema',
];

// Each container file is otherwise valid: only `kind` differs between the accepted and refused case,
// so a refusal can only be the kind's.
const API = { id: 'A1', name: 'Shop', order: 0 };
const SOAP_INTERFACE = {
  ...API,
  kind: 'soap',
  definitionUrl: '',
  cacheDefinition: true,
  endpoints: [],
  wsa: { enabled: false },
  operations: [],
};
const REST_API = { ...API, kind: 'rest', baseUrl: '' };
const GRPC_API = { ...API, kind: 'grpc', target: 'localhost:1' };
const WS_API = { ...API, kind: 'websocket', url: '' };

describe('the file schemas after the split', () => {
  const old: Exports = { ...schema };

  for (const [file, module, names] of MOVED) {
    const shared = file === 'project/schema-parts.ts';
    const title = shared ? `still exports what moved to ${file}, as the same object` : `no longer re-exports ${file}`;
    it(`project/schema.ts ${title}`, () => {
      for (const name of names) {
        expect(module[name], name).toBeDefined();
        expect(old[name], name).toBe(shared ? module[name] : undefined);
      }
    });
  }

  it('keeps the core file schemas in project/schema.ts and nowhere else', () => {
    for (const name of CORE) {
      expect(old[name], name).toBeDefined();
      for (const [file, module] of MOVED) {
        expect(module[name], `${name} in ${file}`).toBeUndefined();
      }
    }
  });

  it.each([
    ['soap', soapFiles.interfaceFileSchema, SOAP_INTERFACE],
    ['rest', restFiles.apiFileSchema, REST_API],
    ['grpc', grpcFiles.grpcApiFileSchema, GRPC_API],
    ['websocket', wsFiles.wsApiFileSchema, WS_API],
  ] as const)('gives %s a container schema that takes its own kind only', (kind, containerSchema, file) => {
    expect(containerSchema.safeParse(file).success).toBe(true);
    for (const other of ['soap', 'rest', 'grpc', 'websocket'].filter((k) => k !== kind)) {
      const result = containerSchema.safeParse({ ...file, kind: other });
      expect(result.success, other).toBe(false);
      expect(
        result.error?.issues.map((issue) => issue.path.join('.')),
        other,
      ).toEqual(['kind']);
    }
  });
});
