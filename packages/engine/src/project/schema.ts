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
 */

import { z } from 'zod';
import { ProjectError } from '../errors.js';
import { FORMAT_VERSION } from './model.js';

const nonEmpty = z.string().min(1);
const propertyMapSchema = z.record(z.string(), z.string());

/**
 * Credentials as persisted: usernames and a `secretRef`, never a password
 * value. Unlike every other schema here, a plaintext `password` key is
 * explicitly rejected rather than merely ignored — secrets must never be
 * written to a project file, in any format.
 */
export const endpointAuthSchema = z
  .looseObject({
    type: z.enum(['none', 'basic', 'ntlm']),
    username: z.string().optional(),
    passwordRef: z.string().optional(),
    domain: z.string().optional(),
    workstation: z.string().optional(),
    preemptive: z.boolean().optional(),
  })
  .refine((value) => !('password' in value), {
    message: 'endpoint auth must not contain a plaintext "password" field; use passwordRef',
    path: ['password'],
  });

const endpointSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  url: z.string(),
  auth: endpointAuthSchema.optional(),
  authMode: z.enum(['override', 'complement']),
});

const wsaSchema = z.looseObject({ enabled: z.boolean(), version: z.enum(['2005/08', '2004/08']).optional() });

const operationEntrySchema = z.looseObject({
  name: nonEmpty,
  bindingName: z.string(),
  slug: nonEmpty,
  order: z.number().int(),
});

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
  activeEnvironmentId: z.string().optional(),
  /** Name of the Wirebench build that last wrote this manifest; informational only. */
  writtenBy: z.string().optional(),
});

/** `interfaces/<slug>/interface.yaml`. */
export const interfaceFileSchema = z.looseObject({
  kind: z.literal('soap'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  definitionUrl: z.string(),
  cacheDefinition: z.boolean(),
  targetNamespace: z.string().optional(),
  endpoints: z.array(endpointSchema),
  defaultEndpointId: z.string().optional(),
  wsa: z.looseObject({ enabled: z.boolean(), version: z.enum(['2005/08', '2004/08']) }),
  auth: endpointAuthSchema.optional(),
  operations: z.array(operationEntrySchema),
});

const requestPropertiesSchema = z.looseObject({
  encoding: z.string(),
  timeoutMs: z.number().int().nonnegative().optional(),
  bindAddress: z.string().optional(),
  followRedirects: z.boolean(),
  skipSoapAction: z.boolean(),
  enableMtom: z.boolean(),
  forceMtom: z.boolean(),
  inlineResponseAttachments: z.boolean(),
  expandMtomAttachments: z.boolean(),
  disableMultiparts: z.boolean(),
  encodeAttachments: z.boolean(),
  enableInlineFiles: z.boolean(),
  removeEmptyContent: z.boolean(),
  entitizeProperties: z.boolean(),
  prettyPrint: z.boolean(),
  stripWhitespaces: z.boolean(),
  dumpFile: z.string().optional(),
  maxSizeBytes: z.number().int().nonnegative().optional(),
  wssPasswordType: z.enum(['text', 'digest']).optional(),
  wssTimeToLive: z.number().int().nonnegative().optional(),
  sslKeystoreRef: z.string().optional(),
});

const attachmentSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  part: z.string().optional(),
  type: z.enum(['XOP', 'MIME', 'SWAREF', 'CONTENT', 'UNKNOWN']),
  contentId: z.string(),
  cached: z.boolean(),
  source: z.union([
    z.looseObject({ kind: z.literal('cache'), sha256: nonEmpty }),
    z.looseObject({ kind: z.literal('path'), path: nonEmpty }),
  ]),
});

/** `interfaces/<slug>/operations/<slug>/<name>.request.yaml` (the envelope lives in the sibling `.xml`). */
export const requestFileSchema = z.looseObject({
  kind: z.literal('soap'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  endpointId: z.string().optional(),
  endpointUrl: z.string().optional(),
  soapVersion: z.enum(['1.1', '1.2']),
  soapAction: z.string().optional(),
  headers: z.array(z.looseObject({ name: z.string(), value: z.string() })),
  attachments: z.array(attachmentSchema),
  auth: endpointAuthSchema.optional(),
  wsa: wsaSchema.optional(),
  wssOutgoingRef: z.string().optional(),
  wssIncomingRef: z.string().optional(),
  properties: requestPropertiesSchema,
});

/** `environments/<slug>.yaml`. */
export const environmentFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  endpoints: z.record(z.string(), z.string()),
  properties: propertyMapSchema,
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

/** A signature entry: the signing key, how its certificate is referenced, and what it covers. */
const wssSignatureEntrySchema = z.looseObject({
  kind: z.literal('signature'),
  keystoreRef: z.string(),
  alias: z.string().optional(),
  keyPasswordRef: z.string().optional(),
  keyIdentifierType: z.enum([
    'BinarySecurityToken',
    'IssuerSerial',
    'SubjectKeyIdentifier',
    'X509KeyIdentifier',
    'Thumbprint',
  ]),
  signatureAlgorithm: z.enum(['rsa-sha256', 'rsa-sha1']),
  digestAlgorithm: z.enum(['sha256', 'sha1']),
  canonicalization: z.literal('exc-c14n'),
  useSingleCertificate: z.boolean(),
  parts: z.array(wssPartSchema),
});

/** An encryption entry. Task 39 defines its fields; loose for the same reason. */
const wssEncryptionEntrySchema = z.looseObject({ kind: z.literal('encryption') });

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

/** `wss/incoming/<name>.yaml`. */
export const wssIncomingFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  decryptKeystoreRef: z.string().optional(),
  signatureKeystoreRef: z.string().optional(),
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

/** The definition cache manifest as persisted. */
export type DefinitionCacheManifest = z.infer<typeof definitionCacheManifestSchema>;
/** One document entry inside a definition cache manifest. */
export type DefinitionCacheDocument = z.infer<typeof definitionCacheDocumentSchema>;

/** The manifest document as persisted. */
export type ManifestFile = z.infer<typeof manifestSchema>;
/** An interface document as persisted. */
export type InterfaceFile = z.infer<typeof interfaceFileSchema>;
/** A request document as persisted (envelope excluded). */
export type RequestFile = z.infer<typeof requestFileSchema>;
/** An environment document as persisted. */
export type EnvironmentFile = z.infer<typeof environmentFileSchema>;

/**
 * Validates `value` against `schema`, raising
 * `ProjectError('project-file-invalid')` carrying the file path and the
 * individual zod issues when it does not match.
 */
export function parseFile<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  throw new ProjectError('project-file-invalid', `Invalid project file ${file}`, {
    details: { file, issues },
  });
}
