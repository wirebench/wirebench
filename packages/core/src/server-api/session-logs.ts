/**
 * The team session-log wire shapes (team session logs and sharing spec, part A). The desktop streams a
 * session's masked text log while it runs; workspace members list and read it. Plain zod only (ADR-0009).
 *
 * The bytes travel as base64 both ways, so a chunk cut inside a UTF-8 character survives the trip; a read
 * answers text ending on a whole character and says where the next read starts.
 */
import { z } from 'zod';
import { teamsIdSchema } from './teams.js';

export const SESSION_LOG_LIMITS = {
  /** Decoded bytes one chunk may carry. */
  maxChunkBytes: 512 * 1024,
  /** Bytes one read answers at most. */
  maxReadBytes: 4 * 1024 * 1024,
  defaultPageSize: 50,
  maxPageSize: 200,
  /** `WIREBENCH_SERVER_SESSION_LOG_MAX_MB`: one log's size past which further bytes are dropped. */
  maxMb: { min: 1, max: 1024, default: 64 },
  maxNameLength: 200,
} as const;

/** The #414 id: compact UTC start time and up to eight letters or digits of the session id. */
export const SESSION_LOG_CLIENT_ID_PATTERN = /^\d{8}T\d{6}Z-[A-Za-z0-9]{1,8}$/;
export const SESSION_LOG_REASONS = ['exit', 'lost', 'closed'] as const;
export type SessionLogReason = (typeof SESSION_LOG_REASONS)[number];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const name = z.string().min(1).max(SESSION_LOG_LIMITS.maxNameLength);
const instant = z.string().datetime({ offset: true });

export const sessionLogParamsSchema = z.object({ workspaceId: teamsIdSchema, logId: teamsIdSchema });

/** `POST /workspaces/:id/session-logs`: opens a log, or finds the one this caller already opened. */
export const sessionLogOpenRequestSchema = z.object({
  clientLogId: z.string().regex(SESSION_LOG_CLIENT_ID_PATTERN),
  hostId: name,
  hostName: name,
  address: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  user: z.string().max(255),
  startedAt: instant,
});
export type SessionLogOpenRequest = z.infer<typeof sessionLogOpenRequestSchema>;
export const sessionLogOpenResponseSchema = z.object({
  id: z.string(),
  /** Bytes the server holds; the client sends from here. */
  size: z.number().int().min(0),
  ended: z.boolean(),
});
export type SessionLogOpenResponse = z.infer<typeof sessionLogOpenResponseSchema>;

/** `POST …/:logId/chunks`: `offset` must equal the size the server holds. */
export const sessionLogChunkRequestSchema = z.object({
  offset: z.number().int().min(0),
  data: z
    .string()
    .min(1)
    .max(Math.ceil(SESSION_LOG_LIMITS.maxChunkBytes / 3) * 4)
    .regex(BASE64),
});
export type SessionLogChunkRequest = z.infer<typeof sessionLogChunkRequestSchema>;
export const sessionLogChunkResponseSchema = z.object({
  size: z.number().int().min(0),
  truncated: z.boolean(),
});
export type SessionLogChunkResponse = z.infer<typeof sessionLogChunkResponseSchema>;

/** `POST …/:logId/end`. */
export const sessionLogEndRequestSchema = z.object({
  endedAt: instant,
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().min(1).max(32).optional(),
  reason: z.enum(SESSION_LOG_REASONS),
});
export type SessionLogEndRequest = z.infer<typeof sessionLogEndRequestSchema>;

/** One log as a member lists it: metadata only. */
export const sessionLogSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  userName: z.string(),
  clientLogId: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  address: z.string(),
  port: z.number().int(),
  user: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  reason: z.enum(SESSION_LOG_REASONS).nullable(),
  size: z.number().int().min(0),
  truncated: z.boolean(),
  /** Not ended yet: the session may still be writing. */
  live: z.boolean(),
});
export type SessionLog = z.infer<typeof sessionLogSchema>;

/** `GET …/session-logs`: newest first; `before` is the last id of the previous page. */
export const sessionLogsQuerySchema = z.object({
  hostId: name.optional(),
  userId: teamsIdSchema.optional(),
  before: teamsIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(SESSION_LOG_LIMITS.maxPageSize).optional(),
});
export type SessionLogsQuery = z.infer<typeof sessionLogsQuerySchema>;
export const sessionLogPageSchema = z.object({
  logs: z.array(sessionLogSchema),
  /** Pass as `before` for the next page; `null` on the last. */
  next: z.string().nullable(),
});
export type SessionLogPage = z.infer<typeof sessionLogPageSchema>;

/** `GET …/:logId/text?offset=`. */
export const sessionLogTextQuerySchema = z.object({ offset: z.coerce.number().int().min(0).optional() });
export type SessionLogTextQuery = z.infer<typeof sessionLogTextQuerySchema>;
export const sessionLogTextResponseSchema = z.object({
  offset: z.number().int().min(0),
  /** The text from `offset`, ending on a whole UTF-8 character. */
  text: z.string(),
  /** Where the next read starts. */
  next: z.number().int().min(0),
  size: z.number().int().min(0),
  truncated: z.boolean(),
  live: z.boolean(),
});
export type SessionLogTextResponse = z.infer<typeof sessionLogTextResponseSchema>;
