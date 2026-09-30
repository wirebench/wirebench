/**
 * The REST files of a project folder: `apis/<slug>/api.yaml` with `kind: rest`, and each
 * `*.request.yaml` of its request tree (spec §3.2). The same request schema reads the items of the
 * project's webhook collection, which is REST requests in a tree of its own.
 */

import { z } from 'zod';
import { assertionsSchema } from '../assert/schema.js';
import {
  attachmentSourceSchema,
  authConfigSchema,
  definitionAuthSchema,
  hookLinkSchema,
  keyValueEntrySchema,
  nonEmpty,
  scriptsSchema,
  webhookSigningSchema,
} from '../project/schema-parts.js';

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
  assertions: assertionsSchema.default([]),
  orphaned: z.boolean().optional(),
  /** The operation of the API's definition this request calls. */
  contract: z.looseObject({ method: nonEmpty, path: nonEmpty }).optional(),
  /** Only under `webhooks/`: the imported `webhooks`/`callbacks` entry; refused elsewhere by the loader. */
  hook: hookLinkSchema.optional(),
  /** Only under `webhooks/`; refused elsewhere by the loader. */
  signing: webhookSigningSchema.optional(),
  scripts: scriptsSchema.optional(),
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
    .looseObject({
      source: nonEmpty,
      cache: z.boolean().default(true),
      version: z.string().default(''),
      auth: definitionAuthSchema.optional(),
    })
    .optional(),
});

/** An API document as persisted. */
export type ApiFile = z.infer<typeof apiFileSchema>;

/** A REST request document as persisted (a raw body's text excluded). */
export type RestRequestFile = z.infer<typeof restRequestFileSchema>;
