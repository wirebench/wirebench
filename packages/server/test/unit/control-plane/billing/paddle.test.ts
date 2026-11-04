/**
 * The Paddle adapter (hosted edition spec §22.5; slice 7 Task 12): each `subscription.*` fixture mapped to the control
 * plane's event, other types ignored, and a subscription without the Team price refused. The fixtures' ids are
 * synthetic.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapPaddleEvent, PADDLE_EVENT_KINDS } from '../../../../src/control-plane/billing/paddle.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/paddle/', import.meta.url));
const TEAM = 'pri_test_team';
const fixture = (type: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${FIXTURES}${type}.json`, 'utf8')) as Record<string, unknown>;
const body = (value: unknown): string => JSON.stringify(value);

describe('the Paddle adapter (spec §22.5)', () => {
  it('has one fixture per subscription event type', () => {
    const files = readdirSync(FIXTURES)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual(Object.keys(PADDLE_EVENT_KINDS).sort());
  });

  it.each(Object.entries(PADDLE_EVENT_KINDS))('maps %s to %s', (type, kind) => {
    const raw = fixture(type);
    const data = raw.data as { status: string; custom_data: Record<string, string> };
    const mapped = mapPaddleEvent(Buffer.from(body(raw)), TEAM);
    expect(mapped.kind).toBe('subscription');
    if (mapped.kind !== 'subscription') return;
    const event = mapped.event;
    expect(event).toMatchObject({
      provider: 'paddle',
      eventId: raw.event_id,
      eventType: type,
      kind,
      ref: 'sub_test_01hv8x2a7b',
      customerRef: 'ctm_test_01hv8x2a7c',
      // 3 + 2 of the Team price; the other price's item is not a seat.
      seats: 5,
      status: kind === 'deleted' ? 'canceled' : data.status,
    });
    expect(event.occurredAt).toEqual(new Date(raw.occurred_at as string));
    if (data.status === 'canceled' || data.status === 'paused') expect(event.periodEnd).toBeNull();
    else expect(event.periodEnd).toEqual(new Date('2026-12-01T10:00:00.000Z'));
    if (type === 'subscription.created') {
      expect(event.signup).toBe(data.custom_data.signup);
      expect(event.tenant).toBeUndefined();
    } else {
      expect(event.tenant).toBe(data.custom_data.tenant);
      expect(event.signup).toBeUndefined();
    }
  });

  it('refuses a subscription without the Team price: billing-no-team-item', () => {
    const raw = fixture('subscription.updated');
    const mapped = mapPaddleEvent(body(raw), 'pri_test_not_this_one');
    expect(mapped).toEqual({
      kind: 'unapplied',
      event: {
        provider: 'paddle',
        eventId: raw.event_id,
        eventType: 'subscription.updated',
        occurredAt: new Date(raw.occurred_at as string),
        outcome: 'billing-no-team-item',
      },
    });
  });

  it('ignores every type outside subscription.*', () => {
    const raw = { ...fixture('subscription.updated'), event_type: 'transaction.completed', data: { id: 'txn_test_1' } };
    const mapped = mapPaddleEvent(body(raw), TEAM);
    expect(mapped.kind).toBe('unapplied');
    expect(mapped.event).toMatchObject({ outcome: 'ignored', eventType: 'transaction.completed' });
  });

  it('records a subscription event in another shape as billing-payload-invalid', () => {
    const raw = fixture('subscription.updated');
    const mapped = mapPaddleEvent(body({ ...raw, data: { id: 'sub_test_1', status: 'mystery', items: [] } }), TEAM);
    expect(mapped.event).toMatchObject({ outcome: 'billing-payload-invalid' });
  });

  it('takes custom data only as short ids, and nothing from an object or a long string', () => {
    const raw = fixture('subscription.updated');
    const data = raw.data as Record<string, unknown>;
    const mapped = mapPaddleEvent(
      body({ ...raw, data: { ...data, custom_data: { tenant: { nested: true }, signup: 'x'.repeat(500) } } }),
      TEAM,
    );
    expect(mapped.kind).toBe('subscription');
    if (mapped.kind !== 'subscription') return;
    expect(mapped.event.tenant).toBeUndefined();
    expect(mapped.event.signup).toBeUndefined();
  });

  it('throws billing-payload-invalid for a body that is not an event', () => {
    for (const bad of ['not json', '[]', '{}', body({ event_id: 'evt 1', event_type: 'x', occurred_at: 'now' })]) {
      expect(() => mapPaddleEvent(bad, TEAM)).toThrow(expect.objectContaining({ code: 'billing-payload-invalid' }));
    }
  });
});
