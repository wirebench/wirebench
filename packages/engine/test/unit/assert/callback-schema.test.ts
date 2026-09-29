// packages/engine/test/unit/assert/callback-schema.test.ts
import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import { CALLBACK_LIMITS } from '../../../src/assert/model.js';
import type { CallbackAssertion } from '../../../src/assert/model.js';
import {
  assertionsSchema,
  callbackAssertionSchema,
  stepAssertionsSchema,
  toCallbackAssertion,
} from '../../../src/assert/schema.js';
import { parseSequenceFile, sequenceDocument } from '../../../src/sequence/file.js';
import { createSequence, createSequenceStep } from '../../../src/sequence/model.js';

const ORDERS: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 30_000,
  match: {
    method: 'POST',
    path: '/events',
    headers: [{ name: 'X-Event', equals: 'order.created' }],
    body: { language: 'jsonpath', path: '$.orderId', equals: '${#Sequence#orderId}' },
  },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }, { signature: 'verified' }],
};

const parse = (value: unknown): CallbackAssertion => toCallbackAssertion(callbackAssertionSchema.parse(value));
const ok = (value: unknown): boolean => callbackAssertionSchema.safeParse(value).success;

describe('callbackAssertionSchema', () => {
  it('reads the YAML form and fills the defaults', () => {
    expect(parse({ type: 'callback', catchUrl: 'orders-hook' })).toEqual({
      type: 'callback',
      catchUrl: 'orders-hook',
      withinMs: CALLBACK_LIMITS.defaultWithinMs,
      match: {},
      expect: [],
    });
    expect(parse(ORDERS)).toEqual(ORDERS);
  });

  it('drops unknown keys at every level', () => {
    expect(
      parse({
        ...ORDERS,
        colour: 'red',
        match: { ...ORDERS.match, extra: 1, headers: [{ name: 'X-Event', equals: 'order.created', note: 'x' }] },
      }),
    ).toEqual(ORDERS);
  });

  it('holds the refinements: one check, one path form, a compiling regex, the withinMs range', () => {
    expect(ok({ type: 'callback', catchUrl: 'h', withinMs: 999 })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', withinMs: 300_001 })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', withinMs: 1_000 })).toBe(true);
    expect(ok({ type: 'callback', catchUrl: 'h', withinMs: 300_000 })).toBe(true);
    expect(ok({ type: 'callback', catchUrl: '' })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { path: '/a', pathMatches: '^/a' } })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { pathMatches: '(' } })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { path: 'events' } })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { headers: [{ name: 'X-A' }] } })).toBe(false);
    expect(
      ok({ type: 'callback', catchUrl: 'h', match: { headers: [{ name: 'X-A', equals: 'a', exists: true }] } }),
    ).toBe(false);
    expect(
      ok({ type: 'callback', catchUrl: 'h', match: { body: { language: 'jsonpath', path: '$.a', matches: '[' } } }),
    ).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', expect: [{}] })).toBe(false);
    expect(
      ok({ type: 'callback', catchUrl: 'h', expect: [{ signature: 'verified', header: { name: 'A', exists: true } }] }),
    ).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', expect: [{ signature: 'failed' }] })).toBe(false);
  });

  it('is a member of both the request and the step catalogue', () => {
    expect(assertionsSchema.parse([ORDERS])).toHaveLength(1);
    expect(stepAssertionsSchema.parse([ORDERS])).toHaveLength(1);
  });

  it('round-trips through a sequence file', () => {
    const sequence = createSequence('Checkout', {
      id: 'S1',
      steps: [createSequenceStep('R-pay', { id: 'T1', assertions: [{ type: 'status', equals: 200 }, ORDERS] })],
    });
    const text = sequenceDocument(sequence);
    const again = parseSequenceFile(text, 'sequences/checkout.sequence.yaml', 'checkout');
    expect(again.steps[0]?.assertions).toEqual([{ type: 'status', equals: 200 }, ORDERS]);
    expect(sequenceDocument(again)).toBe(text);
  });

  it('errors when evaluated outside a run', async () => {
    const [result] = await evaluateAssertions(
      { protocol: 'rest', status: 200, durationMs: 1, bodyText: '', bodyKind: 'other' },
      [ORDERS],
    );
    expect(result).toEqual({
      type: 'callback',
      label: 'callback orders-hook',
      outcome: 'errored',
      message: 'a callback assertion is checked by a run, after its send',
    });
  });
});
