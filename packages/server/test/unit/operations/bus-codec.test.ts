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
/** Every payload's send time here: `encode`'s `at` (epoch ms), the receiver's bus lag (spec §20.8). */
const AT = 1_790_000_000_000;
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
      const payloads = encode(FROM, kind, { ...event, ...PRIVATE }, 0, AT);
      expect(payloads, kind).toHaveLength(1);
      const payload = payloads![0];
      for (const value of [...Object.values(PRIVATE), 'acme-secret-slug', 'name', 'email', 'tenant"']) {
        expect(payload, `${kind}: ${value}`).not.toContain(value);
      }
      const ids: Record<string, unknown> = { ...event };
      delete ids.tenant;
      expect(JSON.parse(payload!), kind).toEqual({ v: 1, from: FROM, at: AT, kind, ...ids });
      expect(decode(payload!), kind).toEqual({ from: FROM, at: AT, kind, event: ids });
    }
  });

  it('refuses an id that is not one rather than send it', () => {
    expect(encode(FROM, 'accessChanged', { tenantId, userId: 'ana@example.com' })).toBeUndefined();
    expect(encode(FROM, 'presenceChanged', { ...EVENTS.presenceChanged, users: ['Ana Lima'] })).toBeUndefined();
    expect(encode(FROM, 'headMoved', { ...EVENTS.headMoved, tenantId: 'acme' })).toBeUndefined();
  });

  it('cuts a big room’s presence into numbered parts under the limit, never truncated (review M1)', () => {
    const users = Array.from({ length: 600 }, () => randomUUID());
    const payloads = encode(FROM, 'presenceChanged', { ...EVENTS.presenceChanged, users }, 7)!;
    expect(payloads.length).toBeGreaterThan(1);
    const parts = payloads.map((payload) => {
      expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      return decode(payload)!.event as AnnouncementEvents['presenceChanged'];
    });
    expect(parts.map((part) => [part.seq, part.part, part.parts])).toEqual(
      parts.map((_, n) => [7, n, payloads.length]),
    );
    expect(parts.flatMap((part) => part.users)).toEqual(users);
    // A part out of range, or a part without its count or sequence, is refused.
    const first = JSON.parse(payloads[0]!) as Record<string, unknown>;
    expect(decode(JSON.stringify({ ...first, part: payloads.length }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...first, parts: undefined }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...first, seq: undefined }))).toBeUndefined();
    // A field outside the kind's list never counts towards the size: it is not copied.
    expect(encode(FROM, 'presenceReset', { holder: FROM, padding: 'x'.repeat(MAX_PAYLOAD_BYTES) }, 0, AT)).toEqual([
      JSON.stringify({ v: 1, from: FROM, at: AT, kind: 'presenceReset', holder: FROM }),
    ]);
  });

  it('stamps every payload with its send time, now by default, which decodes back (spec §20.8 bus lag)', () => {
    const before = Date.now();
    const [payload] = encode(FROM, 'hooksChanged', EVENTS.hooksChanged)!;
    const at = (JSON.parse(payload!) as { at: number }).at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(decode(payload!)?.at).toBe(at);
  });

  it('decodes a payload without a send time, as an instance on the previous version sends it (rolling upgrade)', () => {
    const old = JSON.parse(encode(FROM, 'headMoved', EVENTS.headMoved, 0, AT)![0]!) as Record<string, unknown>;
    delete old.at;
    expect(decode(JSON.stringify(old))).toEqual({ from: FROM, kind: 'headMoved', event: EVENTS.headMoved });
  });

  it('encodes the missed marker as a resync with no tenant (review I2)', () => {
    expect(encode(FROM, 'resync', {}, 0, AT)).toEqual([JSON.stringify({ v: 1, from: FROM, at: AT, kind: 'resync' })]);
    expect(decode(JSON.stringify({ v: 1, from: FROM, at: AT, kind: 'resync' }))).toEqual({
      from: FROM,
      at: AT,
      kind: 'resync',
      event: {},
    });
  });

  it('hears a newer sender’s extra keys, dropped, but refuses another version (review: rolling upgrades)', () => {
    const good = JSON.parse(encode(FROM, 'hooksChanged', EVENTS.hooksChanged, 0, AT)![0]!) as Record<string, unknown>;
    const newer = { ...good, trace: 'abc', email: 'ana@example.com', tenant: { slug: 'acme' } };
    const heard = decode(JSON.stringify(newer));
    expect(heard).toEqual({ from: FROM, at: AT, kind: 'hooksChanged', event: EVENTS.hooksChanged });
    // Nothing of a dropped key reaches a listener.
    expect(JSON.stringify(heard)).not.toContain('ana@example.com');
    expect(JSON.stringify(heard)).not.toContain('acme');
    // A presence part's numbering is known, so kept; on another kind those keys are dropped.
    expect(decode(JSON.stringify({ ...good, seq: 1, part: 0, parts: 2 }))?.event).toEqual(EVENTS.hooksChanged);
    // `v` stays the hard break: a payload of another version is refused, whatever it carries.
    expect(decode(JSON.stringify({ ...newer, v: 2 }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, v: 2 }))).toBeUndefined();
  });

  it('refuses an unknown version, an unknown kind, a known field out of shape and anything not JSON', () => {
    const good = JSON.parse(encode(FROM, 'hooksChanged', EVENTS.hooksChanged)![0]!) as Record<string, unknown>;
    expect(decode(JSON.stringify(good))).toBeDefined();
    expect(decode(JSON.stringify({ ...good, v: 2 }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, kind: 'everything' }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, kind: 'toString' }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, from: 'someone' }))).toBeUndefined();
    // The send time, when present, is a whole, non-negative epoch millisecond.
    expect(decode(JSON.stringify({ ...good, at: -1 }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, at: 1.5 }))).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, at: '2026-11-04' }))).toBeUndefined();
    expect(decode('not json')).toBeUndefined();
    expect(decode('null')).toBeUndefined();
    expect(decode(JSON.stringify({ ...good, workspaceId: 'x'.repeat(MAX_PAYLOAD_BYTES) }))).toBeUndefined();
  });
});
