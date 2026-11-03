/**
 * The notification bus's payloads (hosted edition spec §20.3): `{ v: 1, from, kind, tenantId, …the event's ids }`,
 * JSON, at most {@link MAX_PAYLOAD_BYTES}.
 *
 * - **Ids only** (ADR-0013). Each kind has a fixed list of fields, all ids or closed values (a status, an edition),
 *   and the encoder copies those and nothing else: a scope, a name, an email or file content on the event never
 *   reaches the wire, and an id that looks like anything else is refused on the way in.
 * - **Never truncated.** An event that would not fit is sent as `{ v: 1, from, kind: 'resync', tenantId }`.
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

const envelope = { v: z.literal(BUS_VERSION), from: holder };

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
  presenceChanged: z.strictObject({
    ...envelope,
    kind: z.literal('presenceChanged'),
    tenantId,
    workspaceId: id,
    holder,
    users: z.array(id),
  }),
  presenceReset: z.strictObject({ ...envelope, kind: z.literal('presenceReset'), holder }),
  resync: z.strictObject({ ...envelope, kind: z.literal('resync'), tenantId }),
} as const satisfies Record<AnnouncementKind, z.ZodType>;

/** The fields of each kind that go on the wire, beside `v`, `from` and `kind`. */
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

/** A decoded notification: its sender and kind, and the event as the listeners take it, less any `tenant` scope. */
export type BusMessage = {
  readonly [K in AnnouncementKind]: {
    readonly from: string;
    readonly kind: K;
    readonly event: Omit<AnnouncementEvents[K], 'tenant'>;
  };
}[AnnouncementKind];

/**
 * The payload for one event, or `undefined` when the event itself is out of shape (an id that is not one): that is
 * a bug at the announcing line, and the bus logs it rather than send it. Over the size limit, a `resync` for the
 * event's tenant, or `undefined` when it has none.
 */
export function encode(from: string, kind: AnnouncementKind, event: object): string | undefined {
  const source = event as Readonly<Record<string, unknown>>;
  const wire: Record<string, unknown> = { v: BUS_VERSION, from, kind };
  for (const field of FIELDS[kind]) {
    const value = source[field];
    if (value !== undefined) wire[field] = value;
  }
  if (!WIRE[kind].safeParse(wire).success) return undefined;
  const payload = JSON.stringify(wire);
  if (Buffer.byteLength(payload, 'utf8') <= MAX_PAYLOAD_BYTES) return payload;
  const tenant = source.tenantId;
  if (typeof tenant !== 'string' || !CANONICAL_UUID.test(tenant)) return undefined;
  return JSON.stringify({ v: BUS_VERSION, from, kind: 'resync', tenantId: tenant });
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
  delete event.v;
  delete event.from;
  delete event.kind;
  return { from, kind: kind as AnnouncementKind, event } as BusMessage;
}
