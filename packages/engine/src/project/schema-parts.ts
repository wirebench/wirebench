/**
 * The pieces every project file schema is built from: the non-empty string, the authentication
 * schemes, a table row, a request's `scripts` key, the webhook `hook` and `signing` keys, a request
 * tree's `folder.yaml`, and the two guards every reader calls ({@link assertSupportedKind},
 * {@link parseFile}).
 *
 * Its own file, apart from `schema.ts`, because each protocol's file schemas (`soap/files.ts`,
 * `rest/files.ts`, `grpc/files.ts`, `ws/files.ts`) import these pieces while `schema.ts` re-exports
 * those schemas under their old names: were the pieces in `schema.ts`, the two would import each
 * other, and whichever loaded second would read a binding that is not initialised yet.
 *
 * The strictness policy is `schema.ts`'s: every object is `z.looseObject`, and any additive field
 * bumps `formatVersion` (ADR-0003). This file imports no protocol folder but `webhooks/signature.ts`:
 * the webhook collection is core's until phase 3 of #184.
 */

import { z } from 'zod';
import { ProjectError } from '../errors.js';
import { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';
import { signatureSchemeSchema } from '../webhooks/signature.js';

/** A string with at least one character: an id, a slug, a file name. */
export const nonEmpty = z.string().min(1);

/**
 * A committed, human-chosen name for a secret reference — not the secret itself — used to build
 * the environment variable a CI run reads it from (see `secrets/env-names.ts`).
 */
export const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/)
  .optional();

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
    passwordEnv: envName,
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
    tokenEnv: envName,
    scheme: z.string().optional(),
  }),
);

const apiKeyAuthSchema = refuseSecretValues(
  z.looseObject({
    type: z.literal('api-key'),
    name: z.string(),
    valueRef: z.string().optional(),
    valueEnv: envName,
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
    clientSecretEnv: envName,
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

/**
 * What a SOAP interface, endpoint or request may hold: every {@link authConfigSchema} arm except
 * `inherit` — a SOAP owner has no interface-like ancestor above it to inherit from. The REST
 * schemas are reused, not copied, so the plaintext-secret rejection applies to SOAP files too.
 * `endpointAuthSchema` is deliberately not widened in place: it is itself an arm of this union,
 * and widening its enum would let its looser object shape swallow token configs before the
 * stricter arms see them.
 */
export const soapOwnerAuthSchema = z.union([endpointAuthSchema, bearerAuthSchema, apiKeyAuthSchema, oauth2AuthSchema]);

/**
 * A definition's fetch credentials: Basic, Bearer or API key, each as references only. The Basic arm
 * takes the full plaintext-key rejection too, not only `endpointAuthSchema`'s `password`, so a `token`
 * or `apiKey` written beside `type: basic` is refused rather than ignored.
 */
export const definitionAuthSchema = z.union([
  refuseSecretValues(endpointAuthSchema).refine((auth) => auth.type === 'basic', {
    message: 'a definition supports Basic, not NTLM',
  }),
  bearerAuthSchema,
  apiKeyAuthSchema,
]);

/** Where a file's bytes live: the project's content-addressed cache, or a path on disk. */
export const attachmentSourceSchema = z.union([
  z.looseObject({ kind: z.literal('cache'), sha256: nonEmpty }),
  z.looseObject({ kind: z.literal('path'), path: nonEmpty }),
]);

/**
 * A request's `scripts` key (format 6, #63). `pre` and `post` record the script file names for a
 * reader of the YAML; the loader never reads them, and always opens the name derived from the
 * request's slug (`scriptFileName`), so a hand-edited name cannot reach outside the directory.
 */
export const scriptsSchema = z.looseObject({
  pre: nonEmpty.optional(),
  post: nonEmpty.optional(),
  api: z.enum(['wirebench', 'postman']).default('wirebench'),
  enabled: z.boolean().default(true),
  secrets: z.array(z.string().regex(SECRET_NAME_PATTERN)).default([]),
  timeoutMs: z.number().int().positive().max(10_000).optional(),
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

/** A request's link to the OpenAPI `webhooks`/`callbacks` entry it was imported from. */
export const hookLinkSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('webhook'), name: nonEmpty }),
  z.looseObject({
    kind: z.literal('callback'),
    operation: nonEmpty,
    name: nonEmpty,
    expression: z.string(),
  }),
]);

/**
 * A webhook collection's, folder's or item's `signing` key (webhook-signatures §5.1). References
 * only: a plaintext `secret` is refused outright, as auth refuses its value keys.
 */
export const webhookSigningSchema = z.union([
  z.looseObject({ mode: z.literal('none') }),
  z
    .looseObject({
      mode: z.literal('sign'),
      scheme: signatureSchemeSchema,
      secretRef: z.string().optional(),
      secretEnv: envName,
    })
    .refine((value) => !('secret' in value), {
      message: 'signing must not contain a plaintext "secret" field; use secretRef',
      path: ['secret'],
    }),
]);
export type WebhookSigningFile = z.output<typeof webhookSigningSchema>;

/** `apis/<slug>/requests/[<folder>/…]folder.yaml`. */
export const restFolderFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  auth: authConfigSchema.optional(),
});

/** Every protocol this build can load. A `kind` outside this list is refused by name, never guessed at. */
const SUPPORTED_KINDS = ['soap', 'rest', 'grpc', 'websocket'];

/**
 * Refuses a document whose `kind` this build does not know how to honour — a protocol a later
 * release adds, or a typo — before schema validation, so the error says what is actually wrong
 * ("this build cannot open a graphql document") instead of "expected 'rest', received 'graphql'",
 * and so a project written by a future build fails loudly rather than losing its requests to a
 * dropped unknown key. `grpc` was the reserved name this guard existed for until the gRPC client
 * arrived; it stays for whatever comes next.
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

/** One table row as persisted (params, query, headers, form fields). */
export type KeyValueEntryFile = z.infer<typeof keyValueEntrySchema>;

/** A folder document as persisted. */
export type RestFolderFile = z.infer<typeof restFolderFileSchema>;

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
