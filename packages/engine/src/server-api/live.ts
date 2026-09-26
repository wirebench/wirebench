/**
 * The live-updates protocol (live-updates spec §3.1, §4): one WebSocket at `GET /api/v1/live`, one
 * UTF-8 JSON text message per frame. The server's socket loop parses client messages with
 * {@link liveClientMessageSchema} and the desktop's `LiveClient` parses server messages with
 * {@link liveServerMessageSchema}, so a drift between the two fails typecheck.
 *
 * Plain zod only (ADR-0009). Tokens are on `DEVICE_TOKEN_PATTERN`, workspace ids on `TEAMS_ID_PATTERN`,
 * user ids on `identityIdSchema` and heads on `SYNC_COMMIT_ID_PATTERN`. No message carries a role, an
 * email or file content (§6):
 * HTTP stays the source of truth, and a message only ever says "ask again".
 *
 * The server union is closed on purpose. `LiveClient` skips a `type` it does not know before it parses
 * (§3.1, *Unknown types*), so a newer server can add a message without breaking an older app. zod's
 * default strip drops unknown fields from a known message for the same reason.
 */
import { z } from 'zod';
import { DEVICE_TOKEN_PATTERN, identityIdSchema } from './identity.js';
import { syncCommitIdSchema } from './sync.js';
import { teamsIdSchema } from './teams.js';

/** §3.3's limits, shared so the desktop never sends what the server would refuse. */
export const LIVE_LIMITS = {
  /** A client message's largest size (`maxPayload`); a larger one closes `1009`. Server messages are not capped. */
  maxMessageBytes: 4096,
  /** Across every socket of one device token; the next subscribe is `refused … live-too-many-subscriptions`. */
  maxSubscriptionsPerSession: 200,
  /** Authenticated sockets per user; the next one closes `4429`. */
  maxSocketsPerUser: 32,
  /** How long a socket may wait before its `auth` (then `4408`), and how long the desktop waits for `ready` or `pong`. */
  authTimeoutMs: 10_000,
  /** The server's protocol-ping interval, and the desktop's `ping` interval. */
  heartbeatMs: 30_000,
} as const;

/**
 * The close codes of §3.1. `1000`–`1011` are the protocol's own. The `44xx` codes mirror the HTTP
 * status each stands for. Only `4401` stops the desktop from reconnecting: it runs the token check
 * instead.
 */
export const LIVE_CLOSE = {
  /** The desktop closed it: no open workspace on that server, sign-out, or quit. */
  normal: 1000,
  /** The server is shutting down; the desktop reconnects with back-off. */
  goingAway: 1001,
  /** A client message over `LIVE_LIMITS.maxMessageBytes`. */
  tooBig: 1009,
  /** An unexpected server error on this socket. */
  serverError: 1011,
  /** A malformed or out-of-order message, or a binary frame. */
  badMessage: 4400,
  /** A bad token, an ended session, or the token's maximum age reached. */
  unauthenticated: 4401,
  /** No `auth` within `LIVE_LIMITS.authTimeoutMs`. */
  authTimeout: 4408,
  /** The user already has `LIVE_LIMITS.maxSocketsPerUser` sockets; the desktop waits 60 s. */
  tooManySockets: 4429,
} as const;

/** The `capabilities` entry of `GET /api/v1/meta` that says a server serves {@link LIVE_PATH}. */
export const LIVE_CAPABILITY = 'live';
/** The socket's path on the server's origin. */
export const LIVE_PATH = '/api/v1/live';

/** Why a subscribe was refused. `teams-workspace-not-found` also means "no access", as HTTP does, so an id reveals nothing. */
export const LIVE_REFUSED_CODES = ['teams-workspace-not-found', 'live-too-many-subscriptions'] as const;
export type LiveRefusedCode = (typeof LIVE_REFUSED_CODES)[number];

/**
 * One user with a subscribed socket on a workspace: an id and a display name, never an email (§6).
 * - `id` is `identityIdSchema`: bounded in length and otherwise opaque, as HTTP treats user ids. Nothing
 *   on the client uses it as a path or a storage key, and the e2e fake's ids are `u-<email>`.
 * - `name` is the user's display name, which is never empty.
 */
export const livePresenceUserSchema = z.object({ id: identityIdSchema, name: z.string().min(1) });
export type LivePresenceUser = z.infer<typeof livePresenceUserSchema>;

/** Client → server (§3.1). `auth` comes first, within `authTimeoutMs`, and the token travels nowhere else. */
export const liveClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().regex(DEVICE_TOKEN_PATTERN) }),
  z.object({ type: z.literal('subscribe'), workspaceId: teamsIdSchema }),
  z.object({ type: z.literal('unsubscribe'), workspaceId: teamsIdSchema }),
  z.object({ type: z.literal('ping') }),
]);
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;

/**
 * Server → client (§3.1, R6).
 * - `ready` answers a valid `auth` and `pong` answers `ping`. Together they let the desktop tell
 *   *connecting* from *connected*, and a dead server from a quiet one.
 * - `presence` includes the recipient, whom the desktop removes.
 * - `session-ended` is always followed by a `4401` close.
 */
export const liveServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('head'), workspaceId: teamsIdSchema, head: syncCommitIdSchema }),
  z.object({ type: z.literal('access'), workspaceId: teamsIdSchema }),
  z.object({ type: z.literal('presence'), workspaceId: teamsIdSchema, users: z.array(livePresenceUserSchema) }),
  z.object({ type: z.literal('refused'), workspaceId: teamsIdSchema, code: z.enum(LIVE_REFUSED_CODES) }),
  z.object({ type: z.literal('session-ended') }),
  z.object({ type: z.literal('pong') }),
]);
export type LiveServerMessage = z.infer<typeof liveServerMessageSchema>;
