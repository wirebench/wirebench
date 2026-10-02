/**
 * The WebSocket files of a project folder: `apis/<slug>/api.yaml` with `kind: websocket`, and each
 * `*.request.yaml` of its request tree (spec §3.2).
 */

import { z } from 'zod';
import { assertionsSchema } from '../assert/schema.js';
import { authConfigSchema, definitionAuthSchema, keyValueEntrySchema, nonEmpty } from '../project/schema-parts.js';

const wsSettingsSchema = z.looseObject({
  handshakeTimeoutMs: z.number().int().nonnegative().optional(),
  trustInvalid: z.boolean().optional(),
  sslKeystoreRef: z.string().optional(),
  bindAddress: z.string().optional(),
  maxMessageBytes: z.number().int().nonnegative().optional(),
  escapeProperties: z.boolean().optional(),
});

/**
 * One saved message as persisted: its text (or, for `binary`, base64) lives in the sibling file
 * `file` names, validated as a path segment before it is read (ADR-0005) — the same convention a
 * gRPC message or a REST raw body follows.
 */
const wsSavedMessageSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  format: z.enum(['text', 'binary']).default('text'),
  file: nonEmpty,
  /** The contract message this was generated from, and the sample text it was generated as. */
  contract: z.looseObject({ message: nonEmpty, generated: z.string() }).optional(),
});

/**
 * `apis/<slug>/requests/[<folder>/…]<name>.request.yaml` for a WebSocket request. Each saved
 * message's own text lives in its own sibling file, so a JSON message is a JSON file in git.
 */
export const wsRequestFileSchema = z.looseObject({
  kind: z.literal('websocket'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  url: z.string(),
  query: z.array(keyValueEntrySchema).default([]),
  headers: z.array(keyValueEntrySchema).default([]),
  subprotocols: z.array(z.string()).default([]),
  auth: authConfigSchema.default({ type: 'inherit' }),
  settings: wsSettingsSchema.default({}),
  messages: z.array(wsSavedMessageSchema).default([]),
  assertions: assertionsSchema.default([]),
  /** The channel of the API's contract this request was imported from. */
  contract: z.looseObject({ channel: nonEmpty }).optional(),
  /** The contract no longer has that channel. */
  orphaned: z.boolean().optional(),
});

/** `apis/<slug>/api.yaml` for a WebSocket API. */
export const wsApiFileSchema = z.looseObject({
  kind: z.literal('websocket'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  description: z.string().optional(),
  url: z.string(),
  headers: z.array(keyValueEntrySchema).default([]),
  auth: authConfigSchema.optional(),
  definition: z
    .looseObject({
      kind: z.literal('asyncapi'),
      source: nonEmpty,
      cache: z.boolean().default(true),
      server: z.string().optional(),
      auth: definitionAuthSchema.optional(),
    })
    .optional(),
});

/** A WebSocket `api.yaml` as parsed. */
export type WsApiFile = z.infer<typeof wsApiFileSchema>;
/** A WebSocket `*.request.yaml` as parsed. */
export type WsRequestFile = z.infer<typeof wsRequestFileSchema>;
