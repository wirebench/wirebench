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
 */

import { z } from 'zod';
import { ProjectError } from '../errors.js';
import { FORMAT_VERSION } from './model.js';
import { DEFAULT_WSS_ENCRYPTION_PARTS, DEFAULT_WSS_SIGNATURE_PARTS } from '../wss/model.js';

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

/**
 * Keys that would hold a credential *value* rather than a reference to one. A project file must
 * never carry one, in any authentication scheme, so they are rejected outright rather than
 * ignored — the same rule `endpointAuthSchema` applies to `password`, stated once for the
 * schemes added with the REST client (ADR-0004).
 */
const PLAINTEXT_SECRET_KEYS = [
  'password',
  'token',
  'secret',
  'clientSecret',
  'client_secret',
  'apiKey',
  'refreshToken',
];

/** Adds the {@link PLAINTEXT_SECRET_KEYS} rejection to one authentication schema. */
function refuseSecretValues<T extends z.ZodType<Record<string, unknown>>>(schema: T) {
  return schema.superRefine((value, ctx) => {
    for (const key of PLAINTEXT_SECRET_KEYS) {
      if (key in value) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `auth must not contain a plaintext "${key}" field; use a secretRef`,
        });
      }
    }
  });
}

const inheritAuthSchema = z.looseObject({ type: z.literal('inherit') });

const bearerAuthSchema = refuseSecretValues(
  z.looseObject({
    type: z.literal('bearer'),
    tokenRef: z.string().optional(),
    scheme: z.string().optional(),
  }),
);

const apiKeyAuthSchema = refuseSecretValues(
  z.looseObject({
    type: z.literal('api-key'),
    name: z.string(),
    valueRef: z.string().optional(),
    in: z.enum(['header', 'query']),
  }),
);

const oauth2AuthSchema = refuseSecretValues(
  z.looseObject({
    type: z.literal('oauth2'),
    grant: z.enum(['client-credentials', 'authorization-code']),
    tokenUrl: z.string(),
    authorizationUrl: z.string().optional(),
    clientId: z.string(),
    clientSecretRef: z.string().optional(),
    scopes: z.array(z.string()).default([]),
    audience: z.string().optional(),
    clientAuth: z.enum(['basic', 'body']).default('basic'),
    pkce: z.boolean().default(true),
    refreshTokenRef: z.string().optional(),
  }),
);

/**
 * Authentication as persisted anywhere a project configures it. `endpointAuthSchema` is one arm,
 * so a file written before the REST client — which only ever held `none`/`basic`/`ntlm` — parses
 * unchanged. `inherit` is accepted here and rejected by the SOAP schemas that reuse
 * `endpointAuthSchema` instead, since an interface has nothing to inherit from.
 */
export const authConfigSchema = z.union([
  endpointAuthSchema,
  inheritAuthSchema,
  bearerAuthSchema,
  apiKeyAuthSchema,
  oauth2AuthSchema,
]);

const endpointSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  url: z.string(),
  auth: endpointAuthSchema.optional(),
  authMode: z.enum(['override', 'complement']),
  trustInvalid: z.boolean().optional(),
});

/**
 * A stored WS-Addressing configuration. Every field beyond `enabled` is optional so a project
 * written before the WS-Addressing task — which only ever held `{ enabled, version? }` — still
 * loads; `normalizeWsa` fills the rest in with the v1 defaults.
 */
const wsaSchema = z.looseObject({
  enabled: z.boolean(),
  version: z.enum(['2005/08', '2004/08']).optional(),
  mustUnderstand: z.enum(['none', 'true', 'false']).optional(),
  action: z.string().optional(),
  to: z.string().optional(),
  messageId: z.string().optional(),
  replyTo: z.string().optional(),
  from: z.string().optional(),
  faultTo: z.string().optional(),
  relatesTo: z.string().optional(),
  relationshipType: z.string().optional(),
  addDefaultAction: z.boolean().optional(),
  addDefaultTo: z.boolean().optional(),
  generateMessageId: z.boolean().optional(),
});

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
  /** Names of `properties` entries switched off; absent means none. See `model.ts`'s `Project.disabledProperties`. */
  disabled: z.array(z.string()).optional(),
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
  wsa: wsaSchema,
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

/** Where a file's bytes live: the project's content-addressed cache, or a path on disk. */
export const attachmentSourceSchema = z.union([
  z.looseObject({ kind: z.literal('cache'), sha256: nonEmpty }),
  z.looseObject({ kind: z.literal('path'), path: nonEmpty }),
]);

const attachmentSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  part: z.string().optional(),
  type: z.enum(['XOP', 'MIME', 'SWAREF', 'CONTENT', 'UNKNOWN']),
  contentId: z.string(),
  cached: z.boolean(),
  source: attachmentSourceSchema,
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
  orphaned: z.boolean().optional(),
});

/**
 * One table row as persisted. `enabled` is written only when `false`, so a missing key means
 * enabled; names may repeat and their order is the wire order.
 */
export const keyValueEntrySchema = z.looseObject({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
});

/**
 * An HTTP method: any RFC 9110 token, not just the seven the editor names. A service that speaks
 * `PURGE` or `REPORT` is not a malformed project.
 */
const methodSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'a method must be an HTTP token');

const multipartPartSchema = z.union([
  z.looseObject({
    kind: z.literal('text'),
    name: z.string(),
    value: z.string(),
    enabled: z.boolean().default(true),
    contentType: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal('file'),
    name: z.string(),
    source: attachmentSourceSchema,
    enabled: z.boolean().default(true),
    fileName: z.string().optional(),
    contentType: z.string().optional(),
  }),
]);

/**
 * A request body as persisted. A raw body names its sibling file rather than carrying its text:
 * `file` is a bare file name in the request's own directory, validated as a path segment before
 * anything is read or written (ADR-0005).
 */
export const restBodySchema = z.union([
  z.looseObject({ kind: z.literal('none') }),
  z.looseObject({
    kind: z.literal('raw'),
    language: z.enum(['json', 'xml', 'text', 'html', 'javascript']),
    contentType: z.string().optional(),
    file: nonEmpty,
  }),
  z.looseObject({ kind: z.literal('form'), fields: z.array(keyValueEntrySchema).default([]) }),
  z.looseObject({ kind: z.literal('multipart'), parts: z.array(multipartPartSchema).default([]) }),
  z.looseObject({ kind: z.literal('binary'), source: attachmentSourceSchema, contentType: z.string() }),
]);

const restSettingsSchema = z.looseObject({
  timeoutMs: z.number().int().nonnegative().optional(),
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().nonnegative().optional(),
  keepBodyOnRedirect: z.boolean().optional(),
  encodeUrl: z.boolean().optional(),
  trustInvalid: z.boolean().optional(),
  sslKeystoreRef: z.string().optional(),
  bindAddress: z.string().optional(),
  maxSizeBytes: z.number().int().nonnegative().optional(),
  sendCookies: z.boolean().optional(),
  escapeProperties: z.boolean().optional(),
});

/** `apis/<slug>/requests/[<folder>/…]<name>.request.yaml`. */
export const restRequestFileSchema = z.looseObject({
  kind: z.literal('rest'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  method: methodSchema,
  url: z.string(),
  pathParams: z.array(keyValueEntrySchema).default([]),
  query: z.array(keyValueEntrySchema).default([]),
  headers: z.array(keyValueEntrySchema).default([]),
  body: restBodySchema.default({ kind: 'none' }),
  auth: authConfigSchema.default({ type: 'inherit' }),
  settings: restSettingsSchema.default({}),
  orphaned: z.boolean().optional(),
});

/** `apis/<slug>/requests/[<folder>/…]folder.yaml`. */
export const restFolderFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  auth: authConfigSchema.optional(),
});

/** `apis/<slug>/api.yaml`. */
export const apiFileSchema = z.looseObject({
  kind: z.literal('rest'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  baseUrl: z.string(),
  servers: z.array(z.looseObject({ url: z.string(), description: z.string().optional() })).default([]),
  auth: authConfigSchema.optional(),
  definition: z
    .looseObject({ source: nonEmpty, cache: z.boolean().default(true), version: z.string().default('') })
    .optional(),
});

/** Every protocol this build can load. `grpc` is reserved: recognised, refused, never guessed at. */
const SUPPORTED_KINDS = ['soap', 'rest'];

/**
 * Refuses a document whose `kind` this build knows the name of but cannot honour — today only
 * `grpc`, which the format reserves for a later release.
 *
 * Called before schema validation so the error says what is actually wrong ("this build does not
 * support gRPC") instead of "expected 'rest', received 'grpc'", and so a project written by a
 * future build fails loudly rather than losing its gRPC requests to a dropped unknown key.
 *
 * @throws ProjectError `project-kind-not-supported`
 */
export function assertSupportedKind(document: unknown, file: string): void {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return;
  }
  const kind = (document as Record<string, unknown>)['kind'];
  if (typeof kind !== 'string' || SUPPORTED_KINDS.includes(kind)) {
    return;
  }
  throw new ProjectError(
    'project-kind-not-supported',
    `${file} is a "${kind}" document, which this build cannot open`,
    {
      details: { file, kind, supported: SUPPORTED_KINDS },
    },
  );
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
/** One table row as persisted (params, query, headers, form fields). */
export type KeyValueEntryFile = z.infer<typeof keyValueEntrySchema>;
/** An API document as persisted. */
export type ApiFile = z.infer<typeof apiFileSchema>;
/** A folder document as persisted. */
export type RestFolderFile = z.infer<typeof restFolderFileSchema>;
/** A REST request document as persisted (a raw body's text excluded). */
export type RestRequestFile = z.infer<typeof restRequestFileSchema>;

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
