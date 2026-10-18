import { z } from 'zod';

/**
 * Wire shapes of session logs (`sessionLog.*`, #414). Every channel acts on the calling window's open
 * workspace; a host's id and a log's id are all the renderer names, never a path. No answer carries a
 * credential: the text is masked before it is written. Renderer code imports types from here, never a value
 * (the renderer CSP trap; the switch resolver lives in `session-log-switch.ts`).
 */

const hostIdSchema = z.string().min(1).max(128);
const logIdSchema = z.string().min(1).max(64);

// Requests are strict: a field the channel does not know (a path, say) refuses the call.

export const sessionLogTargetSchema = z.strictObject({ kind: z.enum(['host', 'group']), id: hostIdSchema });

export const sessionLogSwitchesResponseSchema = z.object({
  switches: z.record(z.string(), z.boolean()),
  /** The workspace's server records every SSH session (#430): the switches do not decide while this is set. */
  team: z.boolean().optional(),
});
export type SessionLogSwitchesResponse = z.infer<typeof sessionLogSwitchesResponseSchema>;

/** `on: null` clears the target's own switch, so it follows its group again. */
export const sessionLogSetSwitchRequestSchema = z.strictObject({
  target: sessionLogTargetSchema,
  on: z.boolean().nullable(),
});
export type SessionLogSetSwitchRequest = z.infer<typeof sessionLogSetSwitchRequestSchema>;

/** With no `hostId`, every host's logs in the workspace. */
export const sessionLogListRequestSchema = z.strictObject({ hostId: hostIdSchema.optional() });
export const sessionLogRequestSchema = z.strictObject({ hostId: hostIdSchema, id: logIdSchema });
export type SessionLogRequest = z.infer<typeof sessionLogRequestSchema>;

export const sessionLogEntryWireSchema = z.object({
  id: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  address: z.string(),
  port: z.number().int(),
  user: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().optional(),
  reason: z.enum(['exit', 'lost', 'closed']).optional(),
  raw: z.boolean(),
  bytes: z.number().int(),
  live: z.boolean(),
});
export type SessionLogEntryWire = z.infer<typeof sessionLogEntryWireSchema>;

export const sessionLogListResponseSchema = z.object({ logs: z.array(sessionLogEntryWireSchema) });

export const sessionLogReadResponseSchema = z.object({ text: z.string(), truncated: z.boolean() });
export type SessionLogReadResponse = z.infer<typeof sessionLogReadResponseSchema>;

export const sessionLogSearchRequestSchema = z.strictObject({ hostId: hostIdSchema, query: z.string().max(500) });
export const sessionLogMatchWireSchema = z.object({
  id: z.string(),
  count: z.number().int(),
  line: z.number().int(),
  text: z.string(),
});
export type SessionLogMatchWire = z.infer<typeof sessionLogMatchWireSchema>;
export const sessionLogSearchResponseSchema = z.object({ matches: z.array(sessionLogMatchWireSchema) });

// ---- team session logs (#430): the workspace server's logs, every member's -----------------------

/** With no filter, every host's and member's logs in the workspace, newest first; `before` pages on. */
export const teamSessionLogListRequestSchema = z.strictObject({
  hostId: hostIdSchema.optional(),
  userId: z.string().min(1).max(64).optional(),
  before: z.string().min(1).max(64).optional(),
});
export type TeamSessionLogListRequest = z.infer<typeof teamSessionLogListRequestSchema>;

export const teamSessionLogWireSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  address: z.string(),
  port: z.number().int(),
  user: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  reason: z.enum(['exit', 'lost', 'closed']).nullable(),
  size: z.number().int(),
  truncated: z.boolean(),
  live: z.boolean(),
});
export type TeamSessionLogWire = z.infer<typeof teamSessionLogWireSchema>;

/** `available: false` when the open workspace is not shared to a server: there is nothing to list. */
export const teamSessionLogListResponseSchema = z.object({
  available: z.boolean(),
  logs: z.array(teamSessionLogWireSchema),
  next: z.string().nullable(),
});
export type TeamSessionLogListResponse = z.infer<typeof teamSessionLogListResponseSchema>;

export const teamSessionLogReadRequestSchema = z.strictObject({
  id: z.string().min(1).max(64),
  offset: z.number().int().min(0).optional(),
});
export type TeamSessionLogReadRequest = z.infer<typeof teamSessionLogReadRequestSchema>;
export const teamSessionLogReadResponseSchema = z.object({
  text: z.string(),
  next: z.number().int(),
  size: z.number().int(),
  truncated: z.boolean(),
  live: z.boolean(),
});
export type TeamSessionLogReadResponse = z.infer<typeof teamSessionLogReadResponseSchema>;
