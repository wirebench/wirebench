import { describe, expect, it } from 'vitest';
import {
  LIVE_CAPABILITY,
  LIVE_CLOSE,
  LIVE_LIMITS,
  LIVE_PATH,
  LIVE_REFUSED_CODES,
  liveClientMessageSchema,
  livePresenceUserSchema,
  liveServerMessageSchema,
  type LiveClientMessage,
  type LiveServerMessage,
} from '../../../src/index.js';

const TOKEN = `wbs_${'A'.repeat(43)}`;
const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
/** User ids are opaque (`identityIdSchema`): a server's ULID and the e2e fake's `u-<email>` both pass. */
const USER_A = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const USER_B = 'u-ben@example.com';
/** Heads are on `SYNC_COMMIT_ID_PATTERN`: 40 hex (SHA-1) or 64 hex (SHA-256), lower case. */
const HEAD = 'a'.repeat(40);

describe('server-api live protocol (live-updates §3.1, §4)', () => {
  it('pins the limits, close codes, capability, path and refusal codes the server and the desktop share', () => {
    expect(LIVE_LIMITS).toEqual({
      maxMessageBytes: 4096,
      maxSubscriptionsPerSession: 200,
      maxSocketsPerUser: 32,
      authTimeoutMs: 10_000,
      heartbeatMs: 30_000,
    });
    expect(LIVE_CLOSE).toEqual({
      normal: 1000,
      goingAway: 1001,
      tooBig: 1009,
      serverError: 1011,
      badMessage: 4400,
      unauthenticated: 4401,
      authTimeout: 4408,
      tooManySockets: 4429,
    });
    expect(LIVE_CAPABILITY).toBe('live');
    expect(LIVE_PATH).toBe('/api/v1/live');
    expect(LIVE_REFUSED_CODES).toEqual(['teams-workspace-not-found', 'live-too-many-subscriptions']);
  });

  it('every close code is a protocol code a server may send, or in the application range', () => {
    for (const code of Object.values(LIVE_CLOSE)) {
      expect([1000, 1001, 1009, 1011].includes(code) || (code >= 4000 && code <= 4999)).toBe(true);
    }
  });

  it('parses every client message of §3.1', () => {
    const messages: LiveClientMessage[] = [
      { type: 'auth', token: TOKEN },
      { type: 'subscribe', workspaceId: WS_ID },
      { type: 'unsubscribe', workspaceId: WS_ID },
      { type: 'ping' },
    ];
    for (const message of messages) expect(liveClientMessageSchema.parse(message)).toEqual(message);
  });

  it('refuses a client message with an off-pattern token or id, an unknown type, or no type', () => {
    for (const bad of [
      { type: 'auth', token: 'wbs_short' },
      { type: 'auth', token: `Bearer ${TOKEN}` },
      { type: 'auth' },
      { type: 'subscribe', workspaceId: WS_ID.toLowerCase() },
      { type: 'subscribe', workspaceId: '../etc' },
      { type: 'unsubscribe' },
      { type: 'publish', workspaceId: WS_ID },
      { token: TOKEN },
      'ping',
      null,
    ]) {
      expect(liveClientMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parses every server message of §3.1, with ready and pong (R6)', () => {
    const messages: LiveServerMessage[] = [
      { type: 'ready' },
      { type: 'head', workspaceId: WS_ID, head: HEAD },
      { type: 'head', workspaceId: WS_ID, head: 'b'.repeat(64) },
      { type: 'access', workspaceId: WS_ID },
      {
        type: 'presence',
        workspaceId: WS_ID,
        users: [
          { id: USER_A, name: 'Ana' },
          { id: USER_B, name: 'Ben' },
        ],
      },
      { type: 'presence', workspaceId: WS_ID, users: [] },
      { type: 'refused', workspaceId: WS_ID, code: 'teams-workspace-not-found' },
      { type: 'refused', workspaceId: WS_ID, code: 'live-too-many-subscriptions' },
      { type: 'session-ended' },
      { type: 'pong' },
    ];
    for (const message of messages) expect(liveServerMessageSchema.parse(message)).toEqual(message);
  });

  it('refuses an off-pattern head, an unknown refusal code, and a presence user off its patterns', () => {
    for (const bad of [
      { type: 'head', workspaceId: WS_ID, head: 'main' },
      { type: 'head', workspaceId: WS_ID, head: '--upload-pack=x' },
      { type: 'head', workspaceId: WS_ID, head: HEAD.toUpperCase() },
      { type: 'head', workspaceId: 'nope', head: HEAD },
      { type: 'refused', workspaceId: WS_ID, code: 'sync-access-removed' },
      { type: 'presence', workspaceId: WS_ID, users: [{ id: USER_A }] },
      { type: 'presence', workspaceId: WS_ID, users: [{ id: USER_A, name: '' }] },
      { type: 'presence', workspaceId: WS_ID, users: [{ id: 'x'.repeat(65), name: 'Ana' }] },
      { type: 'presence', workspaceId: WS_ID },
      { type: 'access' },
    ]) {
      expect(liveServerMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('leaves an unknown type to the client catch-all, and strips unknown fields from a known one', () => {
    expect(liveServerMessageSchema.safeParse({ type: 'typing', workspaceId: WS_ID }).success).toBe(false);
    expect(liveServerMessageSchema.parse({ type: 'access', workspaceId: WS_ID, reason: 'later' })).toEqual({
      type: 'access',
      workspaceId: WS_ID,
    });
  });

  it('a presence user is an id and a name, never an email (§6)', () => {
    expect(livePresenceUserSchema.parse({ id: USER_A, name: 'Ana', email: 'ana@example.com' })).toEqual({
      id: USER_A,
      name: 'Ana',
    });
    expect(livePresenceUserSchema.safeParse({ id: '', name: 'Ana' }).success).toBe(false);
    expect(livePresenceUserSchema.safeParse({ id: USER_A, name: '' }).success).toBe(false);
  });
});
