/**
 * The webhook-capture module's wire shapes (webhook-capture spec §3.5, §3.7). The server's routes
 * validate with them through `jsonSchema()` and the desktop's main process parses answers with them,
 * so a drift between the two fails typecheck. Plain zod only (ADR-0009).
 *
 * A catch URL is owned by a workspace. Its secret is the only credential on the public route, so it
 * appears only inside `url`, which only workspace viewers and up can read (§5). The renderer never
 * imports a value from here: main parses, and the renderer takes the inferred types.
 *
 * JSON Schema cannot count UTF-8 bytes or trim, so two checks stay in the handler: a name is trimmed
 * and re-checked, and a response body is measured in bytes (`HOOKS_LIMITS.maxResponseBodyBytes`). The
 * `max` on `body` here is in characters, which is only a cheap first bound.
 */
import { z } from 'zod';
import { teamsIdSchema } from './teams.js';

/** §3.5's validation limits and page sizes, shared so the desktop never sends what the server refuses. */
export const HOOKS_LIMITS = {
  /** A catch URL's name, after trimming. */
  maxNameLength: 100,
  maxContentTypeLength: 255,
  /** A configured response body, in UTF-8 bytes. */
  maxResponseBodyBytes: 65_536,
  /** The configured delay before the answer; no database connection is held meanwhile (§5). */
  maxDelayMs: 30_000,
  defaultPageSize: 50,
  maxPageSize: 200,
} as const;

/** The public route's prefix on the server's origin: `<publicUrl>/hooks/<secret>[/<subpath>]`. */
export const CATCH_URL_PATH_PREFIX = '/hooks/';

/**
 * 128 random bits in Crockford base32: 26 upper-case characters. A minted secret starts 0–7; the
 * pattern does not insist, since Crockford base32 also allows 8–9 as a leading digit for the last two
 * bits of a full 130-bit range and this pattern only bounds the character set and length.
 */
export const CATCH_SECRET_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A configured `Content-Type`: printable ASCII only. A CR or LF would let a stored value split the
 * public route's response header, and Node would throw at send time rather than answer.
 */
export const CATCH_CONTENT_TYPE_PATTERN = /^[\x20-\x7e]+$/;

/** What `/meta` reports (§3.7): whether the Webhooks node shows, and the limits that explain truncation and retention. */
export const hooksMetaSchema = z.object({
  enabled: z.boolean(),
  bodyLimitBytes: z.number().int().positive(),
  keep: z.number().int().positive(),
  maxAgeDays: z.number().int().positive(),
});
export type HooksMeta = z.infer<typeof hooksMetaSchema>;

/** The one fixed answer a catch URL gives every sender (§3.3 step 6). */
export const catchUrlResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  contentType: z.string().max(HOOKS_LIMITS.maxContentTypeLength).regex(CATCH_CONTENT_TYPE_PATTERN).nullable(),
  body: z.string().max(HOOKS_LIMITS.maxResponseBodyBytes).nullable(),
  delayMs: z.number().int().min(0).max(HOOKS_LIMITS.maxDelayMs),
});
export type CatchUrlResponse = z.infer<typeof catchUrlResponseSchema>;

/** What a new catch URL answers until an editor changes it: the database's column defaults. */
export const CATCH_URL_DEFAULT_RESPONSE: CatchUrlResponse = Object.freeze({
  status: 200,
  contentType: null,
  body: null,
  delayMs: 0,
});

const nameSchema = z.string().min(1).max(HOOKS_LIMITS.maxNameLength);

export const catchUrlSchema = z.object({
  id: teamsIdSchema,
  workspaceId: teamsIdSchema,
  name: z.string(),
  /** `publicUrl` + `/hooks/` + the secret. Rotating replaces it. */
  url: z.string(),
  enabled: z.boolean(),
  response: catchUrlResponseSchema,
  captureCount: z.number().int().min(0),
  /** The newest capture's id, `null` with none: the desktop's unseen badge compares it with the last one seen. */
  newestCaptureId: teamsIdSchema.nullable(),
  createdAt: z.string(),
});
export type CatchUrl = z.infer<typeof catchUrlSchema>;
export const catchUrlsResponseSchema = z.array(catchUrlSchema);

export const catchUrlCreateRequestSchema = z.object({
  name: nameSchema,
  enabled: z.boolean().optional(),
  response: catchUrlResponseSchema.partial().optional(),
});
export type CatchUrlCreateRequest = z.infer<typeof catchUrlCreateRequestSchema>;

/** Every field optional; `response.contentType` or `response.body` set to `null` clears it. */
export const catchUrlUpdateRequestSchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  response: catchUrlResponseSchema.partial().optional(),
});
export type CatchUrlUpdateRequest = z.infer<typeof catchUrlUpdateRequestSchema>;

export const catchUrlParamsSchema = z.object({ workspaceId: teamsIdSchema, hookId: teamsIdSchema });
export const captureParamsSchema = z.object({
  workspaceId: teamsIdSchema,
  hookId: teamsIdSchema,
  captureId: teamsIdSchema,
});

/**
 * `GET …/captures?before=&after=&limit=`. Fastify's Ajv coerces the querystring, so the handler reads a
 * number. `before` pages back from an id; `after` returns the `limit` captures right after an id (the
 * gap fill, §4.1). Both at once is refused by the handler (`hooks-cursor-conflict`).
 */
export const capturesQuerySchema = z.object({
  before: teamsIdSchema.optional(),
  after: teamsIdSchema.optional(),
  limit: z.number().int().min(1).max(HOOKS_LIMITS.maxPageSize).optional(),
});
export type CapturesQuery = z.infer<typeof capturesQuerySchema>;

export const captureSummarySchema = z.object({
  /** A ULID: captures sort by arrival. */
  id: teamsIdSchema,
  receivedAt: z.string(),
  method: z.string(),
  /** What followed `/hooks/<secret>`: `''` or `/…`, still percent-encoded as it arrived. */
  subpath: z.string(),
  /** The size that arrived, before truncation. */
  bodySize: z.number().int().min(0),
  truncated: z.boolean(),
  sourceIp: z.string(),
});
export type CaptureSummary = z.infer<typeof captureSummarySchema>;
/** Newest first. */
export const capturesResponseSchema = z.array(captureSummarySchema);

export const captureSchema = captureSummarySchema.extend({
  /** The raw query string, without `?`. */
  query: z.string(),
  /** `[name, value]` pairs in arrival order, repeats kept, names as the sender spelled them. */
  headers: z.array(z.tuple([z.string(), z.string()])),
  /** The stored bytes (at most the server's body limit), base64. */
  body: z.string(),
});
export type Capture = z.infer<typeof captureSchema>;
