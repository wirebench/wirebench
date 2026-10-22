/**
 * The WS-Security entries of an outgoing configuration, as this build understands them. The file
 * schemas (`wss/outgoing/*.yaml`, `wss/incoming/*.yaml`) stay in `project/schema.ts` and hold each
 * entry loosely, so an entry a later build wrote survives a round trip; these are what a send and
 * the editor read an entry as.
 */
import { z } from 'zod';
import { DEFAULT_WSS_ENCRYPTION_PARTS, DEFAULT_WSS_SIGNATURE_PARTS } from './model.js';

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
  token: z.literal(true).optional(),
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
    .enum([
      'BinarySecurityToken',
      'IssuerSerial',
      'SubjectKeyIdentifier',
      'X509KeyIdentifier',
      'Thumbprint',
      'saml-token',
    ])
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

const stsCredentialSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('username'), username: z.string(), passwordRef: z.string().optional() }),
  z.looseObject({
    kind: z.literal('certificate'),
    keystoreRef: z.string().default(''),
    alias: z.string().optional(),
    keyPasswordRef: z.string().optional(),
  }),
  z.looseObject({
    kind: z.literal('kerberos'),
    spn: z.string(),
    principal: z.string().optional(),
    username: z.string().optional(),
    domain: z.string().optional(),
    passwordRef: z.string().optional(),
  }),
]);

export const wssIssuedTokenEntrySchema = z.looseObject({
  kind: z.literal('issued-token'),
  stsUrl: z.string(),
  soapVersion: z.enum(['1.1', '1.2']).default('1.2'),
  trustVersion: z.enum(['1.3', '2005-02']).default('1.3'),
  appliesTo: z.string().optional(),
  tokenType: z.enum(['1.1', '2.0']).default('2.0'),
  keyType: z.enum(['bearer', 'public-key']).default('bearer'),
  proofKeystoreRef: z.string().optional(),
  proofAlias: z.string().optional(),
  credential: stsCredentialSchema,
  requestedLifetimeSeconds: z.number().int().nonnegative().default(0),
  claims: z.string().optional(),
  tlsKeystoreRef: z.string().optional(),
});

const samlAttributeSchema = z.looseObject({
  name: z.string(),
  nameFormat: z.string().optional(),
  values: z.array(z.string()),
});

export const wssSamlTokenEntrySchema = z.discriminatedUnion('source', [
  z.looseObject({
    kind: z.literal('saml-token'),
    source: z.literal('form'),
    version: z.enum(['1.1', '2.0']).default('2.0'),
    issuer: z.string(),
    subject: z.string(),
    subjectFormat: z.string().optional(),
    confirmation: z.enum(['bearer', 'holder-of-key', 'sender-vouches']).default('bearer'),
    audience: z.string().optional(),
    lifetimeSeconds: z.number().int().positive().default(300),
    authnContext: z.string().optional(),
    attributes: z.array(samlAttributeSchema).default([]),
    sign: z
      .looseObject({
        keystoreRef: z.string(),
        alias: z.string().optional(),
        keyPasswordRef: z.string().optional(),
        signatureAlgorithm: z.enum(['rsa-sha256', 'rsa-sha1']).default('rsa-sha256'),
      })
      .optional(),
    proofKeystoreRef: z.string().optional(),
    proofAlias: z.string().optional(),
  }),
  z
    .looseObject({
      kind: z.literal('saml-token'),
      source: z.literal('xml'),
      xml: z.string().optional(),
      file: z.string().optional(),
      expandProperties: z.boolean().default(false),
    })
    .refine((value) => (value.xml === undefined) !== (value.file === undefined), {
      message: 'a SAML token gives exactly one of "xml" and "file"',
      path: ['xml'],
    }),
]);

/** One entry of an outgoing WS-Security configuration, as this build understands it. */
export const wssEntrySchema = z.union([
  wssTimestampEntrySchema,
  wssUsernameTokenEntrySchema,
  wssSignatureEntrySchema,
  wssEncryptionEntrySchema,
  wssIssuedTokenEntrySchema,
  wssSamlTokenEntrySchema,
]);
