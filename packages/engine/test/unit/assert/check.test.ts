/** A request's own assertions as runs and the desktop check them (request-assertions spec §4). */
import { describe, expect, it } from 'vitest';
import { checkRequestAssertions } from '../../../src/assert/check.js';
import type { Assertion, AssertionSubject } from '../../../src/assert/model.js';

const subject: AssertionSubject = {
  protocol: 'rest',
  status: 200,
  durationMs: 40,
  bodyText: '{"ok":true}',
  bodyKind: 'json',
};

const callback: Assertion = {
  type: 'callback',
  catchUrl: 'orders',
  withinMs: 1000,
  match: {},
  expect: [{ body: { language: 'jsonpath', path: '$.id', exists: true } }],
};

describe('checkRequestAssertions', () => {
  it('checks in order, leaving callback assertions to the run', async () => {
    const results = await checkRequestAssertions(subject, [
      { type: 'status', equals: 201 },
      callback,
      { type: 'match', language: 'jsonpath', expression: '$.ok', equals: true },
    ]);
    expect(results.map((r) => [r.type, r.outcome])).toEqual([
      ['status', 'failed'],
      ['match', 'passed'],
    ]);
  });

  it('adds the default SLA only when the request has none', async () => {
    const added = await checkRequestAssertions(subject, [], { defaultSlaMs: 10 });
    expect(added.map((r) => [r.type, r.outcome])).toEqual([['sla', 'failed']]);
    const own = await checkRequestAssertions(subject, [{ type: 'sla', maxMs: 100 }], { defaultSlaMs: 10 });
    expect(own.map((r) => [r.type, r.outcome])).toEqual([['sla', 'passed']]);
  });
});
