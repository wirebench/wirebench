import { z } from 'zod';

/**
 * Wire shapes of shared terminals (`terminalShare.*`, #429). The owner side acts on an SSH session its
 * window owns; the viewer side on a view id main hands out at join. No answer or event carries a token.
 * Renderer code imports types from here, never a value (the renderer CSP trap).
 */

const sessionIdSchema = z.string().min(1).max(128);
const viewIdSchema = z.string().min(1).max(64);
const userIdSchema = z.string().min(1).max(64);
const size = z.number().int().min(1).max(1000);

export const terminalSharePresenceWireSchema = z.object({
  userId: z.string(),
  name: z.string(),
  control: z.boolean(),
  requesting: z.boolean(),
});
export type TerminalSharePresenceWire = z.infer<typeof terminalSharePresenceWireSchema>;

export const terminalShareEndReasonWireSchema = z.enum([
  'ended',
  'owner-left',
  'revoked',
  'access',
  'removed',
  'server',
  'lost',
]);
export type TerminalShareEndReasonWire = z.infer<typeof terminalShareEndReasonWireSchema>;

// Owner.

/** The workspace's server relays shared terminals: Share session… shows only then. */
export const terminalShareAvailableResponseSchema = z.object({ available: z.boolean() });

export const terminalShareStartRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  hostName: z.string().min(1).max(200),
  cols: size,
  rows: size,
});
export type TerminalShareStartRequest = z.infer<typeof terminalShareStartRequestSchema>;
export const terminalShareStartResponseSchema = z.object({ shareId: z.string(), invite: z.string() });
export type TerminalShareStartResponse = z.infer<typeof terminalShareStartResponseSchema>;

export const terminalShareSessionRequestSchema = z.strictObject({ sessionId: sessionIdSchema });
export const terminalShareUserRequestSchema = z.strictObject({ sessionId: sessionIdSchema, userId: userIdSchema });

/** One share's state, to the owner's window: on every presence change, and once when it ends. */
export const terminalShareStateEventSchema = z.object({
  sessionId: z.string(),
  shareId: z.string(),
  invite: z.string(),
  viewers: z.array(terminalSharePresenceWireSchema),
  control: z.string().nullable(),
  ended: terminalShareEndReasonWireSchema.optional(),
});
export type TerminalShareStateEvent = z.infer<typeof terminalShareStateEventSchema>;

// Viewer.

export const terminalShareLinkRequestSchema = z.strictObject({ link: z.string().min(1).max(2048) });
export const terminalSharePreviewResponseSchema = z.object({
  server: z.string(),
  hostName: z.string(),
  ownerName: z.string(),
  viewers: z.number().int(),
});
export type TerminalSharePreviewResponse = z.infer<typeof terminalSharePreviewResponseSchema>;

/** The renderer names the view, so output that arrives before the answer is already its. */
export const terminalShareJoinRequestSchema = z.strictObject({
  link: z.string().min(1).max(2048),
  viewId: viewIdSchema,
});
export type TerminalShareJoinRequest = z.infer<typeof terminalShareJoinRequestSchema>;

export const terminalShareJoinResponseSchema = z.object({
  hostName: z.string(),
  ownerName: z.string(),
  cols: size,
  rows: size,
});
export type TerminalShareJoinResponse = z.infer<typeof terminalShareJoinResponseSchema>;

export const terminalShareViewRequestSchema = z.strictObject({ viewId: viewIdSchema });
export const terminalShareInputRequestSchema = z.strictObject({
  viewId: viewIdSchema,
  data: z.string().max(4096),
});

/** Output for a view, base64. */
export const terminalShareViewerDataEventSchema = z.object({ viewId: z.string(), data: z.string() });
export type TerminalShareViewerDataEvent = z.infer<typeof terminalShareViewerDataEventSchema>;

export const terminalShareViewerStateEventSchema = z.object({
  viewId: z.string(),
  owner: z.object({ userId: z.string(), name: z.string() }).optional(),
  viewers: z.array(terminalSharePresenceWireSchema),
  /** Who holds control; `self` is the signed-in user of this window. */
  control: z.string().nullable(),
  self: z.string().optional(),
  requesting: z.boolean(),
  /** The owner declined the last request. */
  declined: z.boolean().optional(),
  cols: size,
  rows: size,
  ended: terminalShareEndReasonWireSchema.optional(),
});
export type TerminalShareViewerStateEvent = z.infer<typeof terminalShareViewerStateEventSchema>;
