/**
 * Slice 5 Task 3 (hosted edition spec §20.3, ADR-0013): the bus's payloads carry ids only. Every kind is encoded from
 * an event padded with a name, an email, file content and a scope, and none of them reaches the wire.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ANNOUNCEMENT_KINDS, type AnnouncementEvents, type AnnouncementKind } from '../../../src/context.js';
import { decode, encode, MAX_PAYLOAD_BYTES } from '../../../src/operations/bus-codec.js';
import { scopeOf } from '../../../src/tenancy/scope.js';

const FROM = randomUUID();
const TENANT = scopeOf({ id: randomUUID(), slug: 'acme-secret-slug' });
const tenantId = TENANT.tenantId;
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const USER = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';

/** One event of every kind, as a module announces it (scopes included), less the bus's own `resync`. */
const EVENTS: { readonly [K in AnnouncementKind]: AnnouncementEvents[K] } = {
  headMoved: { tenantId, workspaceId: WS, head: 'a'.repeat(40), tokenId: USER },
  accessChanged: { tenantId, tenant: TENANT, teamId: WS, userId: USER },
  sessionEnded: { tenantId, userId: USER, exceptTokenId: WS },
  captureReceived: { tenantId, workspaceId: WS, hookId: USER, captureId: WS },
  hooksChanged: { tenantId, workspaceId: WS },
  licenseChanged: {
    tenantId,
    tenant: TENANT,
    action: 'installed',
    licenseId: WS,
    edition: 'enterprise',
    actorUserId: null,
  },
  scheduleRunFinished: { tenantId, workspaceId: WS, scheduleId: USER, runId: WS, status: 'passed' },
  agentUnpaired: { tenantId, pairingId: WS, userId: USER },
  tenantsChanged: { tenantId },
  tenantKeysChanged: {},
  presenceChanged: { tenantId, workspaceId: WS, holder: FROM, users: [USER, WS] },
  presenceReset: { holder: FROM },
  resync: { tenantId },
};

const PRIVATE = {
  name: 'Ana Lima',
  email: 'ana@example.com',
  displayName: 'Ana',
  content: 'BEGIN PRIVATE KEY',
  body: '{"secret":1}',
};

describe('the bus codec (hosted spec §20.3)', () => {
  it('carries only ids for every kind, and decodes back to the event less its scope', () => {
    for (const kind of ANNOUNCEMENT_KINDS) {
      const event = EVENTS[kind];
      const payload = encode(FROM, kind, { ...event, ...PRIVATE });
      expect(payload, kind).toBeDefined();
      for (const value of [...Object.values(PRIVATE), 'acme-secret-slug', 'name', 'email', 'tenant"']) {
        expect(payload, `${kind}: ${value}`).not.toContain(value);
      }
      const ids: Record<string, unknown> = { ...event };
      delete ids.tenant;
      expect(JSON.parse(payload!), kind).toEqual({ v: 1, from: FROM, kind, ...ids });
      expect(decode(payload!), kind).toEqual({ from: FROM, kind, event: ids });
    }
  });

  it('refuses an id that is not one rather than send it', () => {
    expect(encode(FROM, 'accessChanged', { tenantId, userId: 'ana@example.com' })).toBeUndefined();
    expect(encode(FROM, 'presenceChanged', { ...EVENTS.presenceChanged, users: ['Ana Lima'] })).toBeUndefined();
    expect(encode(FROM, 'headMoved', { ...EVENTS.headMoved, tenantId: 'acme' })).toBeUndefined();
  });

  it('sends an event over the limit as a resync for its tenant, never truncated', () => {
    const users = Array.from({ length: 400 }, () => randomUUID());
    const payload = encode(FROM, 'presenceChanged', { ...EVENTS.presenceChanged, users });
    expect(JSON.parse(payload!)).toEqual({ v: 1, from: FROM, kind: 'resync', tenantId });
    // A field outside the kind's list never counts towards the size: it is not copied.
    expect(encode(FROM, 'presenceReset', { holder: FROM, padding: 'x'.repeat(MAX_PAYLOAD_BYTES) })).toBe(
      JSON.stringify({ v: 1, from: FROM, kind: 'presenceReset', holder: FROM }),
    );
  });

  it('refuses an unknown version, an unknown kind, an extra field and anything not JSON', () => {
    const good = JSON.parse(encode(FROM, 'hooksChanged', EVENTS.hooksChanged)!) as Record<string, unknown>;
    expect(decode(JSON.stringify(good))).toBeDefined();
    expect(decode(JSON.stringify({ ...good, v: 2 }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, kind: 'everything' }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, kind: 'toString' }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, email: 'ana@example.com' }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, from: 'someone' }))).toBeUndefined();
    expect(decode('not json')).toBeUndefined();
    expect(decode('null')).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, workspaceId: 'x'.repeat(MAX_PAYLOAD_BYTES) }))).toBeUndefined();
  });
});
