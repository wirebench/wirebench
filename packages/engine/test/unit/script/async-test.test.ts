/** A test callback that returns a promise fails: a test cannot wait, so it never settled (spec §9). */
import { afterAll, describe, expect, it } from 'vitest';
import type { RestRequestSnapshot } from '../../../src/rest/scripting.js';
import type { ScriptApi, ScriptOutcome } from '../../../src/script/model.js';
import { runScript } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const REQUEST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'GET',
  url: 'https://shop.test/items',
  headers: [],
  body: { kind: 'none' },
};

const MESSAGE = 'the test callback is async, and a test cannot wait: make it synchronous';

const run = (api: ScriptApi, source: string): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase: 'pre',
    api,
    source,
    filename: 'Items.pre.js',
    request: REQUEST,
    vars: {},
    props: {},
    secrets: {},
    requestName: 'Items',
  });

const tests = (outcome: ScriptOutcome) => {
  if (!outcome.ok) throw new Error(`script failed: ${JSON.stringify(outcome)}`);
  return outcome.tests.map((t) => [t.name, t.passed, t.message]);
};

describe('an async test callback', () => {
  const cases: readonly [string, ScriptApi, string][] = [
    ['wirebench: an async test fails', 'wirebench', `test('a', async () => {});`],
    ['postman: an async pm.test fails', 'postman', `pm.test('a', async () => {});`],
    ['insomnia: an async insomnia.test fails', 'insomnia', `insomnia.test('a', async () => {});`],
    ['bruno: an async test fails', 'bruno', `test('a', async () => {});`],
    ['hoppscotch: an async pw.test fails', 'hoppscotch', `pw.test('a', async () => {});`],
    ['hoppscotch: an async hopp.test fails', 'hoppscotch', `hopp.test('a', async () => {});`],
    ['thunder-client: an async tc.test fails', 'thunder-client', `tc.test('a', async () => {});`],
  ];
  it.each(cases)('%s', async (_label, api, source) => {
    expect(tests(await run(api, source))).toEqual([['a', false, MESSAGE]]);
  });

  it('a rejecting async callback fails the same way, without noise', async () => {
    expect(tests(await run('wirebench', `test('a', async () => { throw new Error('x'); });`))).toEqual([
      ['a', false, MESSAGE],
    ]);
  });

  it('a sync test that returns a non-promise value still passes', async () => {
    expect(tests(await run('wirebench', `test('a', () => 5); test('b', () => ({ then: 1 }));`))).toEqual([
      ['a', true, undefined],
      ['b', true, undefined],
    ]);
  });

  it('the script goes on after an async test', async () => {
    const outcome = await run('wirebench', `test('a', async () => {}); vars.set('after', '1');`);
    expect(outcome).toMatchObject({ ok: true, values: [{ name: 'after', value: '1' }] });
  });
});
