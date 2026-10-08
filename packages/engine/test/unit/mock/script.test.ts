/**
 * Dispatch scripts in the sandbox (spec §Script dispatch): what they see, what they can decide, and
 * that a failure of any kind is an answer, never a crash.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { MockRequest } from '../../../src/mock/contract.js';
import { MockState, dispatch } from '../../../src/mock/dispatch.js';
import { createMockOperation, createMockResponse } from '../../../src/mock/model.js';
import { createDispatchScriptRunner } from '../../../src/mock/script.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';

const sandbox = createScriptSandbox();
afterAll(() => sandbox.dispose());
const script = createDispatchScriptRunner(() => sandbox, 1_000);

const REQUEST: MockRequest = {
  method: 'POST',
  path: '/orders/7',
  query: { mode: ['fast'] },
  rawQuery: 'mode=fast',
  headers: [['X-Tier', 'gold']],
  body: Buffer.from('{"qty":3}'),
  bodyText: '{"qty":3}',
};

function op(source: string) {
  return createMockOperation('Place', 'post /orders/{id}', {
    id: 'O1',
    dispatch: 'script',
    defaultResponseId: 'R1',
    script: source,
    responses: [
      createMockResponse('Ok', { id: 'R1' }),
      createMockResponse('Big', { id: 'R2', order: 1 }),
      createMockResponse('Later', { id: 'R3', order: 2, scenario: { name: 'cart', state: 'Full' } }),
    ],
  });
}

async function run(source: string, state = new MockState()) {
  return dispatch(op(source), 'post /orders/{id}', REQUEST, { bodyKind: 'json', pathParams: { id: '7' } }, state, {
    script,
  });
}

describe('dispatch scripts', () => {
  it('see the request and pick a response by name', async () => {
    const result = await run(`
      const order = JSON.parse(request.body) as { qty: number };
      log(request.operation, request.method, request.path, request.query.mode[0], request.pathParams.id, request.headers[0][1]);
      respond(order.qty > 2 ? 'Big' : 'Ok');
    `);
    expect(result.ok && result.response.name).toBe('Big');
    expect(result.log).toEqual(['post /orders/{id} POST /orders/7 fast 7 gold']);
  }, 20_000);

  it('see only the candidates of the current scenario states, and can move a scenario', async () => {
    const state = new MockState();
    const result = await run(
      `log(responses.map((r) => r.name).join(','), scenarios.get('cart')); scenarios.set('cart', 'Full'); respond('Ok');`,
      state,
    );
    expect(result.log).toEqual(['Ok,Big Started']);
    expect(state.scenario('cart')).toBe('Full');
    const next = await run(`respond(responses[responses.length - 1].name);`, state);
    expect(next.ok && next.response.name).toBe('Later');
  }, 20_000);

  it('fall back to the default when they respond with nothing', async () => {
    const result = await run(`log('thinking');`);
    expect(result.ok && result.response.name).toBe('Ok');
  }, 20_000);

  it('fail on an unknown name, a throw, a timeout, a bad scenario state or invalid TypeScript', async () => {
    for (const source of [
      `respond('Nope');`,
      `throw new Error('boom');`,
      `while (true) {}`,
      `scenarios.set('cart', 'a b');`,
      `enum E { A }`,
    ]) {
      const result = await run(source);
      expect(result.ok ? `ok for ${source}` : result.code).toBe('mock-script-failed');
    }
  }, 30_000);

  it('cannot reach the host', async () => {
    const result = await run(`log(typeof process, typeof require, typeof fetch, typeof setTimeout); respond('Ok');`);
    expect(result.log).toEqual(['undefined undefined undefined undefined']);
  }, 20_000);
});
