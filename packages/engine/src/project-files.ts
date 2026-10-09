/**
 * The published JSON Schemas of a project folder (#66): one schema per kind of YAML file, generated
 * from the Zod schemas the loader parses with, so an editor validates a project exactly as far as
 * this build does and the two cannot drift.
 *
 * A core file beside `protocols.ts` because, like it, it lists every protocol: a container or
 * request file is one schema whichever protocol wrote it, told apart by its `kind`. A new kind of
 * file is one entry in {@link PROJECT_FILE_KINDS}; `node scripts/project-schemas.ts` writes the
 * schemas and `--check` fails `pnpm check` when the committed ones are stale.
 *
 * The schemas describe what the loader accepts, not what a save writes: a field with a default is
 * optional, and an unknown key is allowed (it is ignored on load, ADR-0003). A check the Zod
 * schema makes in code — no plaintext secret beside a `secretRef`, say — has no JSON Schema form
 * and is left to the loader.
 */
import { z } from 'zod';
import { grpcApiFileSchema, grpcRequestFileSchema } from './grpc/files.js';
import { FORMAT_VERSION } from './project/model.js';
import {
  apiDefinitionCacheManifestSchema,
  definitionCacheManifestSchema,
  descriptorDefinitionCacheManifestSchema,
  environmentFileSchema,
  keystoresFileSchema,
  manifestSchema,
  protoDefinitionCacheManifestSchema,
  restFolderFileSchema,
  webhookFolderFileSchema,
  webhooksFileSchema,
  wssIncomingFileSchema,
  wssOutgoingFileSchema,
} from './project/schema.js';
import { apiFileSchema, restRequestFileSchema } from './rest/files.js';
import { mockFileSchema, operationFileSchema, responseFileSchema } from './mock/file.js';
import { sequenceFileSchema } from './sequence/file.js';
import { goldenFileSchema } from './snapshot/golden-file.js';
import { interfaceFileSchema, requestFileSchema } from './soap/files.js';
import { wsApiFileSchema, wsRequestFileSchema } from './ws/files.js';

/** One kind of file in a project folder and the schema it is read with. */
export interface ProjectFileKind {
  /** The schema's file name: `<name>.schema.json`. */
  readonly name: string;
  readonly title: string;
  /** Where the files are, as globs relative to the project folder. */
  readonly files: readonly string[];
  readonly schema: z.ZodType;
}

/** Where the schemas are served: the documentation site, one folder per project format version. */
export const PROJECT_SCHEMA_BASE_URL = 'https://wirebench.github.io/wirebench/docs/schemas';

/** Every kind of YAML file a project folder holds. */
export const PROJECT_FILE_KINDS: readonly ProjectFileKind[] = [
  { name: 'manifest', title: 'Project manifest', files: ['wirebench.yaml'], schema: manifestSchema },
  { name: 'environment', title: 'Environment', files: ['environments/*.yaml'], schema: environmentFileSchema },
  { name: 'interface', title: 'SOAP interface', files: ['interfaces/*/interface.yaml'], schema: interfaceFileSchema },
  {
    name: 'soap-request',
    title: 'SOAP request',
    files: ['interfaces/*/operations/*/*.request.yaml'],
    schema: requestFileSchema,
  },
  {
    name: 'interface-definition-manifest',
    title: 'SOAP definition cache manifest',
    files: ['interfaces/*/definition/manifest.yaml'],
    schema: definitionCacheManifestSchema,
  },
  {
    name: 'api',
    title: 'API',
    files: ['apis/*/api.yaml'],
    schema: z.discriminatedUnion('kind', [apiFileSchema, grpcApiFileSchema, wsApiFileSchema]),
  },
  {
    name: 'api-request',
    title: 'API request',
    files: ['apis/*/requests/**/*.request.yaml'],
    schema: z.discriminatedUnion('kind', [restRequestFileSchema, grpcRequestFileSchema, wsRequestFileSchema]),
  },
  { name: 'folder', title: 'Request folder', files: ['apis/*/requests/**/folder.yaml'], schema: restFolderFileSchema },
  {
    name: 'api-definition-manifest',
    title: 'API definition cache manifest',
    files: ['apis/*/definition/manifest.yaml'],
    schema: z.union([
      apiDefinitionCacheManifestSchema,
      protoDefinitionCacheManifestSchema,
      descriptorDefinitionCacheManifestSchema,
    ]),
  },
  { name: 'golden', title: 'Snapshot', files: ['**/*.golden.yaml'], schema: goldenFileSchema },
  { name: 'sequence', title: 'Sequence', files: ['sequences/*.sequence.yaml'], schema: sequenceFileSchema },
  { name: 'mock', title: 'Mock service', files: ['mocks/*/mock.yaml'], schema: mockFileSchema },
  {
    name: 'mock-operation',
    title: 'Mock operation',
    files: ['mocks/*/operations/*/operation.yaml'],
    schema: operationFileSchema,
  },
  {
    name: 'mock-response',
    title: 'Mock response',
    files: ['mocks/*/operations/*/*.response.yaml'],
    schema: responseFileSchema,
  },
  { name: 'webhooks', title: 'Webhook collection', files: ['webhooks/webhooks.yaml'], schema: webhooksFileSchema },
  {
    name: 'webhook-request',
    title: 'Webhook request',
    files: ['webhooks/requests/**/*.request.yaml'],
    schema: restRequestFileSchema,
  },
  {
    name: 'webhook-folder',
    title: 'Webhook folder',
    files: ['webhooks/requests/**/folder.yaml'],
    schema: webhookFolderFileSchema,
  },
  { name: 'keystores', title: 'Keystore registry', files: ['wss/keystores.yaml'], schema: keystoresFileSchema },
  {
    name: 'wss-outgoing',
    title: 'Outgoing WS-Security configuration',
    files: ['wss/outgoing/*.yaml'],
    schema: wssOutgoingFileSchema,
  },
  {
    name: 'wss-incoming',
    title: 'Incoming WS-Security configuration',
    files: ['wss/incoming/*.yaml'],
    schema: wssIncomingFileSchema,
  },
];

/** One generated schema: where it goes under the schemas folder, its kind and the document. */
export interface ProjectJsonSchema {
  /** `v<formatVersion>/<name>.schema.json`. */
  readonly path: string;
  readonly kind: ProjectFileKind;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** The JSON Schema (draft 2020-12) of every kind of project file, in {@link PROJECT_FILE_KINDS} order. */
export function projectJsonSchemas(kinds: readonly ProjectFileKind[] = PROJECT_FILE_KINDS): ProjectJsonSchema[] {
  return kinds.map((kind) => {
    const path = `v${FORMAT_VERSION}/${kind.name}.schema.json`;
    // `input`: a file is what the loader reads, so a field with a default may be left out.
    const { $schema, ...body } = z.toJSONSchema(kind.schema, {
      target: 'draft-2020-12',
      io: 'input',
      unrepresentable: 'any',
    });
    return {
      path,
      kind,
      schema: {
        $schema,
        $id: `${PROJECT_SCHEMA_BASE_URL}/${path}`,
        title: `Wirebench project file: ${kind.title}`,
        description: `Project format ${FORMAT_VERSION}: ${kind.files.map((file) => `\`${file}\``).join(', ')}.`,
        ...body,
      },
    };
  });
}
