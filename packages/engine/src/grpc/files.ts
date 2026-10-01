/**
 * The gRPC files of a project folder: `apis/<slug>/api.yaml` with `kind: grpc`, and each
 * `*.request.yaml` of its request tree (spec §3.2).
 */

import { z } from 'zod';
import { assertionsSchema } from '../assert/schema.js';
import { authConfigSchema, keyValueEntrySchema, nonEmpty, scriptsSchema } from '../project/schema-parts.js';

const grpcSettingsSchema = z.looseObject({
  timeoutMs: z.number().int().nonnegative().optional(),
  trustInvalid: z.boolean().optional(),
  sslKeystoreRef: z.string().optional(),
  bindAddress: z.string().optional(),
  maxSizeBytes: z.number().int().nonnegative().optional(),
  escapeProperties: z.boolean().optional(),
});

/** The four shapes a gRPC method can take. */
export const grpcMethodKindSchema = z.enum(['unary', 'server-streaming', 'client-streaming', 'bidi-streaming']);

/**
 * `apis/<slug>/requests/[<folder>/…]<name>.request.yaml` for a gRPC request. The message text lives
 * in the sibling file `message` names, validated as a path segment before it is read (ADR-0005),
 * so a JSON message is a JSON file in git like a REST raw body.
 */
export const grpcRequestFileSchema = z.looseObject({
  kind: z.literal('grpc'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  service: z.string(),
  method: z.string(),
  methodKind: grpcMethodKindSchema.default('unary'),
  metadata: z.array(keyValueEntrySchema).default([]),
  message: nonEmpty.optional(),
  auth: authConfigSchema.default({ type: 'inherit' }),
  settings: grpcSettingsSchema.default({}),
  orphaned: z.boolean().optional(),
  assertions: assertionsSchema.default([]),
  scripts: scriptsSchema.optional(),
});

/** `apis/<slug>/api.yaml` for a gRPC API. */
export const grpcApiFileSchema = z.looseObject({
  kind: z.literal('grpc'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  target: z.string(),
  tls: z.boolean().default(false),
  metadata: z.array(keyValueEntrySchema).default([]),
  auth: authConfigSchema.optional(),
  definition: z
    .looseObject({
      // Absent in every project written before server reflection, which is an imported set.
      kind: z.enum(['proto', 'reflection']).default('proto'),
      source: nonEmpty,
      cache: z.boolean().default(true),
      roots: z.array(nonEmpty).default([]),
      reflectionVersion: z.enum(['auto', 'v1', 'v1alpha']).optional(),
      trustInvalid: z.boolean().optional(),
    })
    .optional(),
});

/** A gRPC `api.yaml` as parsed. */
export type GrpcApiFile = z.infer<typeof grpcApiFileSchema>;
/** A gRPC `*.request.yaml` as parsed. */
export type GrpcRequestFile = z.infer<typeof grpcRequestFileSchema>;
