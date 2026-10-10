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
import { authConfigSchema, envName, nonEmpty, restFolderFileSchema, webhookSigningSchema } from './schema-parts.js';

// The pieces the protocols' file schemas share are declared in `schema-parts.ts` and keep their
// old names here. A protocol's own file schemas are exported from its folder.
export {
  assertSupportedKind,
  attachmentSourceSchema,
  authConfigSchema,
  definitionAuthSchema,
  endpointAuthSchema,
  hookLinkSchema,
  kerberosAuthSchema,
  keyValueEntrySchema,
  parseFile,
  restFolderFileSchema,
  scriptsSchema,
  soapOwnerAuthSchema,
  webhookSigningSchema,
} from './schema-parts.js';
export type { KeyValueEntryFile, RestFolderFile, WebhookSigningFile } from './schema-parts.js';

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

/** True when `value` holds a `password` key at any depth: secrets are references, everywhere. */
function hasPlaintextPassword(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasPlaintextPassword);
  return Object.entries(value).some(([key, inner]) => key === 'password' || hasPlaintextPassword(inner));
}

/**
 * One entry as *persisted*. Deliberately loose about the entry's own shape — a `signature`
 * entry written by a later build, or a document a foreign tool wrote, must survive a load/save
 * round trip through this build — but a plaintext `password` is rejected outright, wherever in
 * an entry it appears.
 */
const wssStoredEntrySchema = z.looseObject({}).refine((value) => !hasPlaintextPassword(value), {
  message: 'a WS-Security entry must not contain a plaintext "password" field; use passwordRef',
  path: ['password'],
});

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
