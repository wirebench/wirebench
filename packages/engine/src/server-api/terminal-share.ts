/**
 * The live terminal-sharing wire shapes (team session logs and sharing spec, part B). An owner relays the
 * masked screen of one SSH session through Wirebench Server; members of the workspace watch it, and one of
 * them at a time may type once the owner grants control. Nothing about a share is stored: the server holds
 * it in memory and writes audit rows only. Plain zod only (ADR-0009).
 *
 * Output travels as binary frames; everything else as JSON text messages. A client message is at most
 * {@link TERMINAL_SHARE_LIMITS.maxMessageBytes}, the live socket's cap, since the two share one socket server.
 */
import { z } from 'zod';
import { teamsIdSchema } from './teams.js';

export const TERMINAL_SHARE_LIMITS = {
  /** A client message or output frame's largest size; the socket server closes `1009` past it. */
  maxMessageBytes: 4096,
  /** Output a late joiner is sent first: the most recent bytes, held in memory. */
  replayBytes: 256 * 1024,
  /** Viewers one share admits; the next closes `4429`. */
  maxViewers: 20,
  /** Input messages a holder may send per second; past it they are dropped. */
  inputsPerSecond: 64,
  /** How long a created share waits for its owner's socket before it is dropped. */
  ownerAttachMs: 30_000,
  /** How long a socket may wait before its `auth`. */
  authTimeoutMs: 10_000,
  /** Protocol pings; a socket that missed one pong is dropped. */
  heartbeatMs: 30_000,
  maxHostNameLength: 200,
  /** Decoded bytes of one `input` message; base64 keeps the message under the cap. */
  maxInputBytes: 2048,
} as const;

export const TERMINAL_SHARE_CLOSE = {
  normal: 1000,
  goingAway: 1001,
  tooBig: 1009,
  serverError: 1011,
  /** A malformed or out-of-order message, or one the socket's role may not send. */
  badMessage: 4400,
  unauthenticated: 4401,
  /** No access to the workspace, the feature is off, or the caller was removed from this share. */
  forbidden: 4403,
  /** No such share in that workspace. */
  notFound: 4404,
  authTimeout: 4408,
  /** The share ended; an `ended` message came first. */
  ended: 4410,
  /** The share is full, or it already has an owner socket. */
  tooMany: 4429,
} as const;

/** The `capabilities` entry, and the license feature, of a server that relays shared terminals. */
export const TERMINAL_SHARE_CAPABILITY = 'terminal-sharing';
/** The socket's path on the server's origin. */
export const TERMINAL_SHARE_PATH = '/api/v1/terminal-shares/socket';

export const TERMINAL_SHARE_END_REASONS = ['ended', 'owner-left', 'revoked', 'access', 'removed', 'server'] as const;
export type TerminalShareEndReason = (typeof TERMINAL_SHARE_END_REASONS)[number];

/** 128 random bits in lowercase base32, unpadded. */
export const TERMINAL_SHARE_ID_PATTERN = /^[a-z2-7]{26}$/;
export const terminalShareIdSchema = z.string().regex(TERMINAL_SHARE_ID_PATTERN);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const size = z.number().int().min(1).max(1000);
const hostName = z.string().min(1).max(TERMINAL_SHARE_LIMITS.maxHostNameLength);
const userId = teamsIdSchema;
/** A user id the server reports: taken as given, so a client never drops a message over an id's shape. */
const reportedUserId = z.string().min(1).max(128);
const inputData = z
  .string()
  .max(Math.ceil(TERMINAL_SHARE_LIMITS.maxInputBytes / 3) * 4)
  .regex(BASE64);

/** `POST /workspaces/:workspaceId/terminal-shares`. */
export const terminalShareCreateRequestSchema = z.object({ hostName, cols: size, rows: size });
export type TerminalShareCreateRequest = z.infer<typeof terminalShareCreateRequestSchema>;
export const terminalShareCreateResponseSchema = z.object({ shareId: terminalShareIdSchema });
export type TerminalShareCreateResponse = z.infer<typeof terminalShareCreateResponseSchema>;

export const terminalShareParamsSchema = z.object({ workspaceId: teamsIdSchema, shareId: terminalShareIdSchema });

/** `GET /workspaces/:workspaceId/terminal-shares/:shareId`: what the join dialog shows. */
export const terminalShareInfoSchema = z.object({
  hostName,
  ownerName: z.string(),
  viewers: z.number().int().min(0),
});
export type TerminalShareInfo = z.infer<typeof terminalShareInfoSchema>;

/** Every message a client may send; which ones a socket may send depends on its role. */
export const terminalShareClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth'),
    token: z.string().min(1).max(2048),
    workspaceId: teamsIdSchema,
    shareId: terminalShareIdSchema,
  }),
  z.object({ type: z.literal('ping') }),
  // The owner's.
  z.object({ type: z.literal('resize'), cols: size, rows: size }),
  z.object({ type: z.literal('grant'), userId }),
  z.object({ type: z.literal('decline'), userId }),
  z.object({ type: z.literal('take-back') }),
  z.object({ type: z.literal('remove'), userId }),
  z.object({ type: z.literal('end') }),
  // A viewer's.
  z.object({ type: z.literal('request-control') }),
  z.object({ type: z.literal('release') }),
  z.object({ type: z.literal('input'), data: inputData }),
]);
export type TerminalShareClientMessage = z.infer<typeof terminalShareClientMessageSchema>;

export const terminalSharePresenceEntrySchema = z.object({
  userId: reportedUserId,
  name: z.string(),
  /** Holds control: their keystrokes reach the session. */
  control: z.boolean(),
  /** Asked for control and waits for the owner. */
  requesting: z.boolean(),
});
export type TerminalSharePresenceEntry = z.infer<typeof terminalSharePresenceEntrySchema>;

export const terminalShareServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), role: z.literal('owner') }),
  z.object({
    type: z.literal('viewer-ready'),
    hostName,
    ownerName: z.string(),
    cols: size,
    rows: size,
  }),
  z.object({
    type: z.literal('presence'),
    owner: z.object({ userId: reportedUserId, name: z.string() }),
    viewers: z.array(terminalSharePresenceEntrySchema),
  }),
  /** To the owner: the holder typed this. */
  z.object({ type: z.literal('input'), userId: reportedUserId, data: inputData }),
  z.object({ type: z.literal('resize'), cols: size, rows: size }),
  z.object({ type: z.literal('control'), userId: reportedUserId.nullable() }),
  /** To a viewer: the owner declined their request. */
  z.object({ type: z.literal('declined') }),
  z.object({ type: z.literal('ended'), reason: z.enum(TERMINAL_SHARE_END_REASONS) }),
  z.object({ type: z.literal('pong') }),
]);
export type TerminalShareServerMessage = z.infer<typeof terminalShareServerMessageSchema>;

/** What an invite link names. */
export interface TerminalShareInvite {
  /** The server's origin. */
  readonly server: string;
  readonly workspaceId: string;
  readonly shareId: string;
}

const INVITE_PREFIX = 'wirebench://terminal-share/';

/** `wirebench://terminal-share/<shareId>?server=<origin>&workspace=<workspaceId>`. */
export function formatTerminalShareInvite(invite: TerminalShareInvite): string {
  const query = new URLSearchParams({ server: invite.server, workspace: invite.workspaceId });
  return `${INVITE_PREFIX}${invite.shareId}?${query.toString()}`;
}

/** The invite a pasted link names, or `undefined` for anything that is not one. */
export function parseTerminalShareInvite(text: string): TerminalShareInvite | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) return undefined;
  const [shareId = '', search = ''] = trimmed.slice(INVITE_PREFIX.length).split('?', 2);
  const query = new URLSearchParams(search);
  const server = query.get('server');
  const workspaceId = query.get('workspace');
  if (!TERMINAL_SHARE_ID_PATTERN.test(shareId) || server === null || workspaceId === null) return undefined;
  if (!teamsIdSchema.safeParse(workspaceId).success) return undefined;
  let origin: string;
  try {
    const url = new URL(server);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    origin = url.origin;
  } catch {
    return undefined;
  }
  return { server: origin, workspaceId, shareId };
}
