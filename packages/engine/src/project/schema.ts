/**
 * Zod schemas for every YAML document in a project folder.
 *
 * Every object schema is `z.looseObject`: unknown keys are accepted and
 * IGNORED on load (the loader only ever reads the fields it knows about), and
 * `saveProject` only ever writes known fields back out, so a 1.x build reading
 * a file written by a newer 1.x build silently drops fields it does not
 * understand rather than refusing to open the project. A breaking change to a
 * document's shape bumps `formatVersion` instead of relying on strictness
 * here. `formatVersion` itself stays a `z.literal` so an out-of-range value is
 * still caught explicitly (see `migrate.ts`).
 *
 * The policy that follows from that, stated once so nobody has to rediscover
 * it: **any additive field bumps `formatVersion`.** Since an unknown key is
 * dropped on load and never written back, a field added inside the current
 * version does not merely go unread by older builds — it is deleted from the
 * project the first time an older build saves. "Additive is safe" is true of
 * formats that round-trip unknown keys; this one deliberately does not. See
 * ADR-0003.
 *
 * This file holds the core documents only: the manifest, an environment, the keystore registry, the
 * WS-Security configurations, the webhook collection and the definition-cache manifests. A
 * protocol's container and request files are in its own folder (`soap/files.ts`, `rest/files.ts`,
 * `grpc/files.ts`, `ws/files.ts`), and the pieces they share in `schema-parts.ts`.
 */

import { z } from 'zod';
import { FORMAT_VERSION } from './model.js';
import { DEFAULT_WSS_ENCRYPTION_PARTS, DEFAULT_WSS_SIGNATURE_PARTS } from '../wss/model.js';
import { authConfigSchema, envName, nonEmpty, restFolderFileSchema, webhookSigningSchema } from './schema-parts.js';

// Everything that moved out keeps its old name here until the public exports change (slice 5 of
// the protocol modules plan), so no importer of this file had to change with the move.
export {
  assertSupportedKind,
  attachmentSourceSchema,
  authConfigSchema,
  definitionAuthSchema,
  endpointAuthSchema,
  hookLinkSchema,
  keyValueEntrySchema,
  parseFile,
  restFolderFileSchema,
  scriptsSchema,
  soapOwnerAuthSchema,
  webhookSigningSchema,
} from './schema-parts.js';
export type { KeyValueEntryFile, RestFolderFile, WebhookSigningFile } from './schema-parts.js';
export { interfaceFileSchema, requestFileSchema } from '../soap/files.js';
export type { InterfaceFile, RequestFile } from '../soap/files.js';
export { apiFileSchema, restBodySchema, restRequestFileSchema } from '../rest/files.js';
export type { ApiFile, RestRequestFile } from '../rest/files.js';
export { grpcApiFileSchema, grpcMethodKindSchema, grpcRequestFileSchema } from '../grpc/files.js';
export type { GrpcApiFile, GrpcRequestFile } from '../grpc/files.js';
export { wsApiFileSchema, wsRequestFileSchema } from '../ws/files.js';
export type { WsApiFile, WsRequestFile } from '../ws/files.js';

const propertyMapSchema = z.record(z.string(), z.string());

/** `wirebench.yaml`. */
export const manifestSchema = z.looseObject({
  formatVersion: z.literal(FORMAT_VERSION),
  id: nonEmpty,
  name: z.string(),
  description: z.string().optional(),
  settings: z.looseObject({
    cacheDefinitions: z.boolean(),
    defaultTimeoutMs: z.number().int().positive(),
    resourceRoot: z.string().optional(),
    prettyPrintResponses: z.boolean(),
  }),
  properties: propertyMapSchema,
  /** Names of `properties` entries switched off; absent means none. See `model.ts`'s `Project.disabledProperties`. */
  disabled: z.array(z.string()).optional(),
  activeEnvironmentId: z.string().optional(),
  /** Name of the Wirebench build that last wrote this manifest; informational only. */
  writtenBy: z.string().optional(),
});

/** `webhooks/webhooks.yaml`. */
export const webhooksFileSchema = z.looseObject({
  target: z.string(),
  auth: authConfigSchema.optional(),
  signing: webhookSigningSchema.optional(),
});

/** `webhooks/requests/[<folder>/…]folder.yaml`: a REST folder plus a target override and its source API. */
export const webhookFolderFileSchema = restFolderFileSchema.extend({
  target: z.string().optional(),
  source: z.looseObject({ apiId: nonEmpty }).optional(),
  signing: webhookSigningSchema.optional(),
});

/** The `kind` of an `api.yaml`, read ahead of full validation so the loader knows which schema applies. */
export function apiKindOf(document: unknown): 'rest' | 'grpc' | 'websocket' {
  const kind =
    typeof document === 'object' && document !== null ? (document as Record<string, unknown>)['kind'] : undefined;
  if (kind === 'grpc' || kind === 'websocket') {
    return kind;
  }
  return 'rest';
}

/** `environments/<slug>.yaml`. */
export const environmentFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  endpoints: z.record(z.string(), z.string()),
  properties: propertyMapSchema,
  /** Names of `properties` entries switched off; absent means none. */
  disabled: z.array(z.string()).optional(),
});

/** A `wsu:Timestamp` entry inside an outgoing configuration. */
const wssTimestampEntrySchema = z.looseObject({
  kind: z.literal('timestamp'),
  timeToLiveSeconds: z.number().int().nonnegative(),
  millisecondPrecision: z.boolean(),
});

/**
 * A `wsse:UsernameToken` entry. As with `endpointAuthSchema`, a plaintext `password` key is
 * rejected outright rather than merely ignored: WS-Security passwords live in the secret store.
 */
const wssUsernameTokenEntrySchema = z
  .looseObject({
    kind: z.literal('username-token'),
    username: z.string(),
    passwordRef: z.string().optional(),
    passwordType: z.enum(['text', 'digest', 'none']),
    addNonce: z.boolean(),
    addCreated: z.boolean(),
  })
  .refine((value) => !('password' in value), {
    message: 'a WS-Security username token must not contain a plaintext "password" field; use passwordRef',
    path: ['password'],
  });

/** One `{name, namespace, encode}` message part a signature covers. */
const wssPartSchema = z.looseObject({
  name: z.string(),
  namespace: z.string(),
  encode: z.enum(['Content', 'Element']),
});

/**
 * A signature entry: the signing key, how its certificate is referenced, and what it covers.
 *
 * Every field but `kind` defaults, so a bare `{kind:'signature'}` — a Task 37-era file, or one
 * a foreign tool wrote with only the fields it cared about — loads as a complete, if useless,
 * signature entry rather than being rejected outright; the editor is expected to fill in a real
 * `keystoreRef` before the entry can actually be applied.
 */
const wssSignatureEntrySchema = z.looseObject({
  kind: z.literal('signature'),
  keystoreRef: z.string().default(''),
  alias: z.string().optional(),
  keyPasswordRef: z.string().optional(),
  keyIdentifierType: z
    .enum(['BinarySecurityToken', 'IssuerSerial', 'SubjectKeyIdentifier', 'X509KeyIdentifier', 'Thumbprint'])
    .default('BinarySecurityToken'),
  signatureAlgorithm: z.enum(['rsa-sha256', 'rsa-sha1']).default('rsa-sha256'),
  digestAlgorithm: z.enum(['sha256', 'sha1']).default('sha256'),
  canonicalization: z.literal('exc-c14n').default('exc-c14n'),
  useSingleCertificate: z.boolean().default(true),
  parts: z
    .array(wssPartSchema)
    .default(DEFAULT_WSS_SIGNATURE_PARTS as { name: string; namespace: string; encode: 'Content' | 'Element' }[]),
});

/**
 * An encryption entry. Tolerant the same way the signature entry is: every field defaults, so a
 * document written by hand (or by an older build) still loads as a usable entry rather than
 * falling through the union to "unsupported".
 */
const wssEncryptionEntrySchema = z.looseObject({
  kind: z.literal('encryption'),
  keystoreRef: z.string().default(''),
  alias: z.string().optional(),
  keyIdentifierType: z
    .enum(['BinarySecurityToken', 'IssuerSerial', 'SubjectKeyIdentifier', 'X509KeyIdentifier', 'Thumbprint'])
    .default('BinarySecurityToken'),
  symmetricAlgorithm: z.enum(['aes128-cbc', 'aes256-cbc', 'aes128-gcm', 'aes256-gcm']).default('aes256-gcm'),
  keyTransportAlgorithm: z.enum(['rsa-oaep', 'rsa-1_5']).default('rsa-oaep'),
  embedKey: z.boolean().default(false),
  encryptSymmetricKey: z.boolean().default(true),
  parts: z
    .array(wssPartSchema)
    .default(DEFAULT_WSS_ENCRYPTION_PARTS as { name: string; namespace: string; encode: 'Content' | 'Element' }[]),
});

/**
 * One entry as *persisted*. Deliberately loose about the entry's own shape — a `signature`
 * entry written by a later build, or a document a foreign tool wrote, must survive a load/save
 * round trip through this build — but a plaintext `password` is rejected outright, wherever in
 * an entry it appears.
 */
const wssStoredEntrySchema = z.looseObject({}).refine((value) => !('password' in value), {
  message: 'a WS-Security entry must not contain a plaintext "password" field; use passwordRef',
  path: ['password'],
});

/** One entry of an outgoing WS-Security configuration, as this build understands it. */
export const wssEntrySchema = z.union([
  wssTimestampEntrySchema,
  wssUsernameTokenEntrySchema,
  wssSignatureEntrySchema,
  wssEncryptionEntrySchema,
]);

/** `wss/outgoing/<name>.yaml`. */
export const wssOutgoingFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  defaultAlias: z.string().optional(),
  defaultPasswordRef: z.string().optional(),
  actor: z.string().optional(),
  mustUnderstand: z.boolean().optional(),
  entries: z.array(wssStoredEntrySchema).optional(),
});

/**
 * `wss/incoming/<name>.yaml`. Tolerant in the same way the outgoing entries are: every field
 * but `id`/`name` defaults, so a document written by an older build (which had only the two
 * keystore refs) loads as a complete configuration rather than being rejected.
 */
export const wssIncomingFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  decryptKeystoreRef: z.string().optional(),
  decryptAlias: z.string().optional(),
  decryptKeyPasswordRef: z.string().optional(),
  signatureKeystoreRef: z.string().optional(),
  requireSignature: z.boolean().optional(),
  requireTimestamp: z.boolean().optional(),
  timestampSkewSeconds: z.number().int().nonnegative().optional(),
  verifyChain: z.boolean().optional(),
});

/**
 * One `wss/keystores.yaml` entry: mirrors the engine's `KeystoreDef`. `looseObject` so a field
 * a later build adds survives a load/save round trip through this one. Never a password — only
 * a `secretRef` the host resolves through `safeStorage`.
 */
export const keystoreEntrySchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  path: nonEmpty,
  type: z.enum(['pkcs12', 'pem']),
  passwordSecretRef: z.string().optional(),
  passwordEnv: envName,
  defaultAlias: z.string().optional(),
});

/** `wss/keystores.yaml` — the project's client keystore registry. */
export const keystoresFileSchema = z.looseObject({
  keystores: z.array(keystoreEntrySchema),
});

/** One document entry inside `interfaces/<slug>/definition/manifest.yaml`. */
const definitionCacheDocumentSchema = z.looseObject({
  file: nonEmpty,
  location: nonEmpty,
  requestedLocation: z.string().optional(),
  kind: z.enum(['wsdl', 'xsd']),
  sha256: nonEmpty,
  bytes: z.number().int().nonnegative(),
  importedBy: z.string().optional(),
  namespace: z.string().optional(),
  chameleonFor: z.string().optional(),
});

/** `interfaces/<slug>/definition/manifest.yaml`. */
export const definitionCacheManifestSchema = z.looseObject({
  formatVersion: z.literal(1),
  rootLocation: nonEmpty,
  fetchedAt: nonEmpty,
  documents: z.array(definitionCacheDocumentSchema),
});

/** One entry of `apis/<slug>/definition/manifest.yaml`. */
const apiDefinitionCacheDocumentSchema = z.looseObject({
  file: nonEmpty,
  location: nonEmpty,
  requestedLocation: z.string().optional(),
  sha256: nonEmpty,
  bytes: z.number().int().nonnegative(),
});

/**
 * `apis/<slug>/definition/manifest.yaml`. Its own schema rather than the WSDL one because an
 * OpenAPI document has no `kind`, `namespace` or `importedBy` to record — a JSON or YAML file
 * references its siblings by location and nothing else.
 */
export const apiDefinitionCacheManifestSchema = z.looseObject({
  formatVersion: z.literal(1),
  rootLocation: nonEmpty,
  fetchedAt: nonEmpty,
  /** The `openapi` string the root document declared, so the API tab can show it without parsing. */
  declaredVersion: z.string().optional(),
  documents: z.array(apiDefinitionCacheDocumentSchema),
});

/** One `.proto` file of `apis/<slug>/definition/manifest.yaml` for a gRPC API. */
const protoDefinitionCacheFileSchema = z.looseObject({
  /** The import path, which is also the path under `definition/protos/`. */
  path: nonEmpty,
  sha256: nonEmpty,
  bytes: z.number().int().nonnegative(),
});

/**
 * `apis/<slug>/definition/manifest.yaml` for a gRPC API: the `.proto` files an import was made of,
 * each stored byte-exact under `protos/` at its import path so the set loads again exactly as the
 * imports spell it. The `kind` tells a reader which of the two API manifests it has.
 */
export const protoDefinitionCacheManifestSchema = z.looseObject({
  formatVersion: z.literal(1),
  kind: z.literal('proto'),
  /** Where the files came from, as the user gave it. */
  source: nonEmpty,
  fetchedAt: nonEmpty,
  roots: z.array(nonEmpty),
  files: z.array(protoDefinitionCacheFileSchema),
});

/** The proto definition cache manifest as persisted. */
export type ProtoDefinitionCacheManifest = z.infer<typeof protoDefinitionCacheManifestSchema>;

/**
 * `apis/<slug>/definition/manifest.yaml` for a gRPC API discovered by server reflection: one binary
 * `FileDescriptorSet` beside it, because a server describes itself in the compiler's own output and
 * there is no `.proto` text to keep. The `kind` is what tells the two gRPC manifests apart.
 */
export const descriptorDefinitionCacheManifestSchema = z.looseObject({
  formatVersion: z.literal(1),
  kind: z.literal('descriptors'),
  /** The target the server was asked at, as the user gave it. */
  source: nonEmpty,
  fetchedAt: nonEmpty,
  /** The descriptor files declaring the services, which the set is loaded from. */
  roots: z.array(nonEmpty).default([]),
  /** The reflection protocol version that answered. */
  reflectionVersion: z.enum(['v1', 'v1alpha']).optional(),
  /** The descriptor set itself: its path under `definition/`, its SHA-256 and its size. */
  file: protoDefinitionCacheFileSchema,
});

/** The descriptor definition cache manifest as persisted. */
export type DescriptorDefinitionCacheManifest = z.infer<typeof descriptorDefinitionCacheManifestSchema>;

/** The API definition cache manifest as persisted. */
export type ApiDefinitionCacheManifest = z.infer<typeof apiDefinitionCacheManifestSchema>;

/** One document of an API definition cache, as the manifest records it. */
export type ApiDefinitionCacheDocument = z.infer<typeof apiDefinitionCacheDocumentSchema>;

/** The definition cache manifest as persisted. */
export type DefinitionCacheManifest = z.infer<typeof definitionCacheManifestSchema>;
/** One document entry inside a definition cache manifest. */
export type DefinitionCacheDocument = z.infer<typeof definitionCacheDocumentSchema>;

/** The manifest document as persisted. */
export type ManifestFile = z.infer<typeof manifestSchema>;

/** An environment document as persisted. */
export type EnvironmentFile = z.infer<typeof environmentFileSchema>;
