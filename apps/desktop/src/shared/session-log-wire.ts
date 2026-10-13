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

export const sessionLogSwitchesResponseSchema = z.object({ switches: z.record(z.string(), z.boolean()) });
export type SessionLogSwitchesResponse = z.infer<typeof sessionLogSwitchesResponseSchema>;

/** `on: null` clears the target's own switch, so it follows its group again. */
export const sessionLogSetSwitchRequestSchema = z.strictObject({
  target: sessionLogTargetSchema,
  on: z.boolean().nullable(),
});
export type SessionLogSetSwitchRequest = z.infer<typeof sessionLogSetSwitchRequestSchema>;

export const sessionLogHostRequestSchema = z.strictObject({ hostId: hostIdSchema });
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
