/**
 * Picking a stub (spec §Dispatch): each style, every match source and check, scenarios, the default
 * and the two "nothing to send" outcomes — and the guarantees that make it safe under concurrency and
 * against a hostile pattern from a shared file.
 */
import { describe, expect, it } from 'vitest';
import type { MockRequest, MockRequestView } from '../../../src/mock/contract.js';
import { MockState, candidates, dispatch } from '../../../src/mock/dispatch.js';
import type { DispatchScriptRunner } from '../../../src/mock/dispatch.js';
import { createMockOperation, createMockResponse } from '../../../src/mock/model.js';
import type { MockMatch, MockOperation, MockResponse } from '../../../src/mock/model.js';

function request(over: Partial<MockRequest> = {}): MockRequest {
  const bodyText = over.bodyText ?? '';
  return {
    method: 'POST',
    path: '/orders/42',
    query: {},
    rawQuery: '',
    headers: [],
    body: Buffer.from(bodyText),
    bodyText,
    ...over,
  };
}

const XML_VIEW: MockRequestView = { bodyKind: 'xml', pathParams: {} };
const JSON_VIEW: MockRequestView = { bodyKind: 'json', pathParams: { id: '42' } };

function response(name: string, over: Partial<Parameters<typeof createMockResponse>[1]> = {}): MockResponse {
  return createMockResponse(name, { id: name, ...over });
}

function operation(dispatchStyle: MockOperation['dispatch'], responses: MockResponse[], defaultResponseId?: string) {
  return createMockOperation('Op', 'op', {
    id: 'O1',
    dispatch: dispatchStyle,
    responses,
    ...(defaultResponseId !== undefined ? { defaultResponseId } : {}),
  });
}

async function pick(op: MockOperation, state = new MockState(), req = request(), view = XML_VIEW): Promise<string> {
  const result = await dispatch(op, 'op', req, view, state);
  return result.ok ? result.response.name : result.code;
}

async function matches(condition: MockMatch, req: MockRequest, view: MockRequestView): Promise<boolean> {
  const op = operation('match', [response('hit', { match: [condition] }), response('miss')]);
  return (await pick(op, new MockState(), req, view)) === 'hit';
}

describe('mock dispatch', () => {
  it('sequence takes each candidate in turn and wraps', async () => {
    const op = operation('sequence', [response('a'), response('b'), response('c')]);
    const state = new MockState();
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) seen.push(await pick(op, state));
    expect(seen).toEqual(['a', 'b', 'c', 'a', 'b']);
    state.reset();
    expect(await pick(op, state)).toBe('a');
  });

  it('two concurrent requests take two sequence slots', async () => {
    const op = operation('sequence', [response('a'), response('b')]);
    const state = new MockState();
    const both = await Promise.all([pick(op, state), pick(op, state)]);
    expect(both.sort()).toEqual(['a', 'b']);
  });

  it('random stays within the candidates, using the random source it is given', async () => {
    const op = operation('random', [response('a'), response('b'), response('c')]);
    const draws: number[] = [];
    const result = await dispatch(op, 'op', request(), XML_VIEW, new MockState(), {
      random: (n) => {
        draws.push(n);
        return 2;
      },
    });
    expect(draws).toEqual([3]);
    expect(result.ok && result.response.name).toBe('c');
  });

  it('match takes the first candidate whose conditions all hold; one with none is a catch-all', async () => {
    const op = operation('match', [
      response('vip', {
        match: [
          { from: 'header', name: 'x-tier', equals: 'gold' },
          { from: 'query', name: 'debug', exists: false },
        ],
      }),
      response('any'),
    ]);
    expect(await pick(op, new MockState(), request({ headers: [['X-Tier', 'gold']] }))).toBe('vip');
    expect(await pick(op, new MockState(), request({ headers: [['X-Tier', 'gold']], query: { debug: ['1'] } }))).toBe(
      'any',
    );
  });

  it("reads the body by XPath, with the request's own prefixes when none are given", async () => {
    const body =
      '<s:Envelope xmlns:s="urn:s"><s:Body><o:Order xmlns:o="urn:o"><o:sku>SKU-0</o:sku></o:Order></s:Body></s:Envelope>';
    const req = request({ bodyText: body });
    expect(
      await matches({ from: 'body', language: 'xpath', expression: '//o:sku', equals: 'SKU-0' }, req, XML_VIEW),
    ).toBe(true);
    expect(
      await matches(
        { from: 'body', language: 'xpath', expression: '//x:sku', namespaces: { x: 'urn:o' }, matches: '^SKU-\\d$' },
        req,
        XML_VIEW,
      ),
    ).toBe(true);
    expect(
      await matches({ from: 'body', language: 'xpath', expression: '//o:sku', equals: 'SKU-1' }, req, XML_VIEW),
    ).toBe(false);
  });

  it('reads the body by JSONPath, and a path parameter', async () => {
    const req = request({ bodyText: '{"order":{"qty":3}}' });
    expect(
      await matches({ from: 'body', language: 'jsonpath', expression: '$.order.qty', equals: '3' }, req, JSON_VIEW),
    ).toBe(true);
    expect(await matches({ from: 'body', language: 'jsonpath', expression: '$.nope' }, req, JSON_VIEW)).toBe(false);
    expect(await matches({ from: 'path', name: 'id', equals: '42' }, req, JSON_VIEW)).toBe(true);
    // JSONPath on an XML body never holds.
    expect(await matches({ from: 'body', language: 'jsonpath', expression: '$' }, req, XML_VIEW)).toBe(false);
  });

  it('a condition that cannot compile is false and reported, and the next candidate is tried', async () => {
    const op = operation('match', [
      response('broken', { match: [{ from: 'body', language: 'xpath', expression: '//[' }] }),
      response('any'),
    ]);
    const result = await dispatch(op, 'op', request({ bodyText: '<a/>' }), XML_VIEW, new MockState());
    expect(result.ok && result.response.name).toBe('any');
    expect(result.problems.map((p) => p.code)).toEqual(['mock-match-failed']);
  });

  it('a catastrophic pattern from a shared file times out without blocking the server', async () => {
    const op = operation('match', [
      response('slow', { match: [{ from: 'header', name: 'x', matches: '^(a+)+$' }] }),
      response('any'),
    ]);
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 50);
    const result = await dispatch(
      op,
      'op',
      request({ headers: [['x', `${'a'.repeat(40)}!`]] }),
      XML_VIEW,
      new MockState(),
    );
    clearInterval(timer);
    expect(result.ok && result.response.name).toBe('any');
    expect(result.problems[0]?.code).toBe('mock-match-failed');
    expect(ticks).toBeGreaterThan(5);
  }, 15_000);

  it('scenarios filter the candidates and move on when a response is sent', async () => {
    const op = operation('sequence', [
      response('empty', { scenario: { name: 'stock', state: 'Started', next: 'Restocked' } }),
      response('full', { scenario: { name: 'stock', state: 'Restocked' } }),
    ]);
    const state = new MockState();
    expect(candidates(op, state).map((r) => r.name)).toEqual(['empty']);
    expect(await pick(op, state)).toBe('empty');
    expect(state.scenario('stock')).toBe('Restocked');
    expect(await pick(op, state)).toBe('full');
    expect(await pick(op, state)).toBe('full');
    state.reset();
    expect(await pick(op, state)).toBe('empty');
  });

  it('falls back to the default whatever its state, then to no-response, and no-stub for an empty operation', async () => {
    const gated = response('later', { scenario: { name: 's', state: 'Never' } });
    expect(await pick(operation('sequence', [gated], 'later'))).toBe('later');
    expect(await pick(operation('sequence', [gated]))).toBe('mock-no-response');
    expect(await pick(operation('match', [response('x', { match: [{ from: 'query', name: 'q' }] })]))).toBe(
      'mock-no-response',
    );
    expect(await pick(operation('random', []))).toBe('mock-no-stub');
  });

  it('script picks by name, sets scenario states, and fails on a name that is not a candidate', async () => {
    const op = { ...operation('script', [response('a'), response('b')], 'a'), script: '/* any */' };
    const runner =
      (decision: Awaited<ReturnType<DispatchScriptRunner>>): DispatchScriptRunner =>
      () =>
        Promise.resolve(decision);
    const state = new MockState();
    const chosen = await dispatch(op, 'op', request(), XML_VIEW, state, {
      script: runner({ ok: true, response: 'b', scenarios: { cart: 'Full' }, log: ['picked b'] }),
    });
    expect(chosen.ok && chosen.response.name).toBe('b');
    expect(chosen.log).toEqual(['picked b']);
    expect(state.scenario('cart')).toBe('Full');

    const none = await dispatch(op, 'op', request(), XML_VIEW, state, {
      script: runner({ ok: true, scenarios: {}, log: [] }),
    });
    expect(none.ok && none.response.name).toBe('a');

    const unknown = await dispatch(op, 'op', request(), XML_VIEW, state, {
      script: runner({ ok: true, response: 'zzz', scenarios: {}, log: [] }),
    });
    expect(unknown.ok ? 'ok' : unknown.code).toBe('mock-script-failed');

    const failed = await dispatch(op, 'op', request(), XML_VIEW, state, {
      script: runner({ ok: false, message: 'boom', log: [] }),
    });
    expect(failed.ok ? 'ok' : failed.message).toBe('boom');
  });

  it('a script operation without a script or a runner fails', async () => {
    expect(await pick(operation('script', [response('a')]))).toBe('mock-script-failed');
  });
});
