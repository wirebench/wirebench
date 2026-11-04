/**
 * The notification bus's payloads (hosted edition spec §20.3): `{ v: 1, from, at, kind, tenantId, …the event's ids }`,
 * JSON, at most {@link MAX_PAYLOAD_BYTES}. `at` is the sender's clock when it queued the event (epoch ms): the receiver's
 * `wirebench.bus.lag` (spec §20.8). It is always sent and optional on the way in (a previous version sends none).
 *
 * - **Ids only** (ADR-0013). Each kind has a fixed list of fields, all ids or closed values (a status, an edition),
 *   and the encoder copies those and nothing else: a scope, a name, an email or file content on the event never
 *   reaches the wire, and an id that looks like anything else is refused on the way in.
 * - **Never truncated.** A room's presence over the limit goes as several `presenceChanged` parts, each under it,
 *   numbered `part` of `parts` and sharing one `seq`; the receiving hub replaces the holder's list once it has them all
 *   (review M1). Any other event that would not fit is sent as `{ v: 1, from, at, kind: 'resync', tenantId }`.
 * - **The missed marker** is a `resync` with no `tenantId`: the sender lost events it could not send, and every peer
 *   resyncs everything, as after a lost bus of its own (review I2).
 * - **Strict on the way in.** An unknown `v`, an unknown kind or a field out of shape is refused whole. The
 *   decoder does not brand a scope: the bus rebuilds `tenant` from `tenantId` through the tenant directory.
 */
import { z } from 'zod';
import { editionSchema, scheduleRunStatusSchema } from '@wirebench/engine';
import type { AnnouncementEvents, AnnouncementKind } from '../context.js';
import { CANONICAL_UUID } from '../tenancy/scope.js';

/** PostgreSQL's limit is 8 000 bytes; the rest is headroom (spec §20.3). */
export const MAX_PAYLOAD_BYTES = 7_900;

export const BUS_VERSION = 1;

/** Ids as the server makes them: ULIDs, UUIDs and commit hashes. No `@`, `.` or space, so never an email or a name. */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const tenantId = z.string().regex(CANONICAL_UUID);
const holder = z.string().regex(CANONICAL_UUID);

/**
 * `at` is optional on the way in: an instance on the previous version sends none during a rolling upgrade, and its
 * events must still be heard. Every payload this version encodes carries it.
 */
const envelope = { v: z.literal(BUS_VERSION), from: holder, at: z.number().int().nonnegative().optional() };

/** Every kind's wire shape: what is copied out of an event and checked on the way back in. */
const WIRE = {
  headMoved: z.strictObject({
    ...envelope,
    kind: z.literal('headMoved'),
    tenantId,
    workspaceId: id,
    head: id,
    tokenId: id,
  }),
  accessChanged: z.strictObject({
    ...envelope,
    kind: z.literal('accessChanged'),
    tenantId,
    workspaceId: id.optional(),
    teamId: id.optional(),
    userId: id.optional(),
  }),
  sessionEnded: z.union([
    z.strictObject({ ...envelope, kind: z.literal('sessionEnded'), tenantId, tokenId: id }),
    z.strictObject({
      ...envelope,
      kind: z.literal('sessionEnded'),
      tenantId,
      userId: id,
      exceptTokenId: id.optional(),
    }),
  ]),
  captureReceived: z.strictObject({
    ...envelope,
    kind: z.literal('captureReceived'),
    tenantId,
    workspaceId: id,
    hookId: id,
    captureId: id,
  }),
  hooksChanged: z.strictObject({ ...envelope, kind: z.literal('hooksChanged'), tenantId, workspaceId: id }),
  licenseChanged: z.strictObject({
    ...envelope,
    kind: z.literal('licenseChanged'),
    tenantId,
    action: z.enum(['installed', 'removed']),
    licenseId: id.optional(),
    edition: editionSchema.optional(),
    actorUserId: id.nullable(),
  }),
  scheduleRunFinished: z.strictObject({
    ...envelope,
    kind: z.literal('scheduleRunFinished'),
    tenantId,
    workspaceId: id,
    scheduleId: id,
    runId: id,
    status: scheduleRunStatusSchema,
  }),
  agentUnpaired: z.strictObject({
    ...envelope,
    kind: z.literal('agentUnpaired'),
    tenantId,
    pairingId: id,
    userId: id,
  }),
  tenantsChanged: z.strictObject({ ...envelope, kind: z.literal('tenantsChanged'), tenantId: tenantId.optional() }),
  tenantKeysChanged: z.strictObject({
    ...envelope,
    kind: z.literal('tenantKeysChanged'),
    tenantId: tenantId.optional(),
  }),
  presenceChanged: z
    .strictObject({
      ...envelope,
      kind: z.literal('presenceChanged'),
      tenantId,
      workspaceId: id,
      holder,
      users: z.array(id),
      seq: z.number().int().nonnegative().optional(),
      part: z.number().int().nonnegative().optional(),
      parts: z.number().int().min(2).optional(),
    })
    .refine(
      (wire) =>
        (wire.parts === undefined) === (wire.part === undefined) &&
        (wire.parts === undefined) === (wire.seq === undefined) &&
        (wire.parts === undefined || wire.part! < wire.parts),
    ),
  presenceReset: z.strictObject({ ...envelope, kind: z.literal('presenceReset'), holder }),
  resync: z.strictObject({ ...envelope, kind: z.literal('resync'), tenantId: tenantId.optional() }),
} as const satisfies Record<AnnouncementKind, z.ZodType>;

/** The fields of each kind that go on the wire, beside `v`, `from`, `at` and `kind`. */
const FIELDS: { readonly [K in AnnouncementKind]: readonly string[] } = {
  headMoved: ['tenantId', 'workspaceId', 'head', 'tokenId'],
  accessChanged: ['tenantId', 'workspaceId', 'teamId', 'userId'],
  sessionEnded: ['tenantId', 'tokenId', 'userId', 'exceptTokenId'],
  captureReceived: ['tenantId', 'workspaceId', 'hookId', 'captureId'],
  hooksChanged: ['tenantId', 'workspaceId'],
  licenseChanged: ['tenantId', 'action', 'licenseId', 'edition', 'actorUserId'],
  scheduleRunFinished: ['tenantId', 'workspaceId', 'scheduleId', 'runId', 'status'],
  agentUnpaired: ['tenantId', 'pairingId', 'userId'],
  tenantsChanged: ['tenantId'],
  tenantKeysChanged: ['tenantId'],
  presenceChanged: ['tenantId', 'workspaceId', 'holder', 'users'],
  presenceReset: ['holder'],
  resync: ['tenantId'],
};

/**
 * A decoded notification: its sender, when it was sent (the sender's epoch ms) and its kind, and the event as the
 * listeners take it, less any `tenant` scope.
 */
export type BusMessage = {
  readonly [K in AnnouncementKind]: {
    readonly from: string;
    /** Absent from an instance on the previous version: no lag is recorded for it. */
    readonly at?: number;
    readonly kind: K;
    readonly event: Omit<AnnouncementEvents[K], 'tenant'>;
  };
}[AnnouncementKind];

/**
 * The payloads for one event, in order: one, or a big room's presence in parts that share `seq` (the sender's own
 * counter). `undefined` when the event itself is out of shape (an id that is not one): that is a bug at the
 * announcing line, and the bus logs it rather than send it. Any other kind over the size limit becomes a `resync`
 * for the event's tenant, or `undefined` when it has none. `at` is the send time, now by default.
 */
export function encode(
  from: string,
  kind: AnnouncementKind,
  event: object,
  seq = 0,
  at: number = Date.now(),
): string[] | undefined {
  const source = event as Readonly<Record<string, unknown>>;
  const wire: Record<string, unknown> = { v: BUS_VERSION, from, at: Math.max(0, Math.trunc(at)), kind };
  for (const field of FIELDS[kind]) {
    const value = source[field];
    if (value !== undefined) wire[field] = value;
  }
  if (!WIRE[kind].safeParse(wire).success) return undefined;
  const payload = JSON.stringify(wire);
  if (Buffer.byteLength(payload, 'utf8') <= MAX_PAYLOAD_BYTES) return [payload];
  if (kind === 'presenceChanged') return presenceParts(wire, seq);
  const tenant = source.tenantId;
  if (typeof tenant !== 'string' || !CANONICAL_UUID.test(tenant)) return undefined;
  return [JSON.stringify({ v: BUS_VERSION, from, at: wire.at, kind: 'resync', tenantId: tenant })];
}

/**
 * A presence list cut, in order, into parts under the limit. Ids are ASCII (the `id` pattern), so each costs its
 * length, two quotes and a comma; the envelope is measured once with the widest numbers it can carry.
 */
function presenceParts(wire: Readonly<Record<string, unknown>>, seq: number): string[] {
  const users = wire.users as readonly string[];
  const envelopeBytes = Buffer.byteLength(
    JSON.stringify({ ...wire, users: [], seq, part: users.length, parts: users.length }),
    'utf8',
  );
  const chunks: string[][] = [[]];
  let bytes = envelopeBytes;
  for (const user of users) {
    const cost = user.length + 3;
    if (bytes + cost > MAX_PAYLOAD_BYTES && chunks.at(-1)!.length > 0) {
      chunks.push([]);
      bytes = envelopeBytes;
    }
    chunks.at(-1)!.push(user);
    bytes += cost;
  }
  return chunks.map((chunk, part) => JSON.stringify({ ...wire, users: chunk, seq, part, parts: chunks.length }));
}

/** The message in `payload`, or `undefined` for anything this version does not know. Never throws. */
export function decode(payload: string): BusMessage | undefined {
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const kind = (parsed as { readonly kind?: unknown }).kind;
  if (typeof kind !== 'string' || !Object.hasOwn(WIRE, kind)) return undefined;
  const checked = WIRE[kind as AnnouncementKind].safeParse(parsed);
  if (!checked.success) return undefined;
  const event: Record<string, unknown> = { ...checked.data };
  const from = event.from as string;
  const at = event.at as number | undefined;
  delete event.v;
  delete event.from;
  delete event.at;
  delete event.kind;
  return { from, ...(at !== undefined ? { at } : {}), kind: kind as AnnouncementKind, event } as BusMessage;
}
