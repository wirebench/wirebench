/**
 * The Thunder Client layer: `tc` over the typed script API; the calls the sandbox cannot honour fail
 * with `script-unsupported`, and the importer's scan names the same calls.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { runControlCalls, unsupportedCalls } from '../../../src/import/scripts.js';
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../src/rest/scripting.js';
import type { ScriptOutcome } from '../../../src/script/model.js';
import { runScript } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const REQUEST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'POST',
  url: 'https://shop.test/graphql',
  headers: [['Content-Type', 'application/json']],
  body: { kind: 'text', text: '{"item":"a"}', language: 'json' },
};
const RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 200,
  statusText: 'OK',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Id', '7'],
  ],
  text: '{"data":{"product":{"name":"Ada"}}}',
  durationMs: 42,
};

const run = (
  phase: 'pre' | 'post',
  source: string,
  extra: { vars?: Record<string, string>; response?: RestResponseSnapshot } = {},
): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase,
    api: 'thunder-client',
    source,
    filename: `Product by id.${phase}.js`,
    request: REQUEST,
    ...(phase === 'post' ? { response: extra.response ?? RESPONSE } : {}),
    vars: extra.vars ?? {},
    props: { baseUrl: 'https://shop.test', tenant: 'acme' },
    secrets: {},
    requestName: 'Product by id',
  });

describe('the Thunder Client layer: variables', () => {
  it('runs the collection-1.2 fixture post script', async () => {
    // fixtures/thunder-client/crafted/collection-1.2.json, request "Product by id".
    const outcome = await run('post', 'var json = tc.response.json;\ntc.setVar("firstName", json.data.product.name);');
    expect(outcome).toMatchObject({ ok: true, values: [{ name: 'firstName', value: 'Ada' }] });
  });

  it('setVar with each scope writes vars', async () => {
    const outcome = await run(
      'pre',
      `tc.setVar('a', '1', 'local'); tc.setVar('b', '2', 'global'); tc.setVar('c', '3', 'request'); tc.setVar('d', '4');`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' },
        { name: 'c', value: '3' },
        { name: 'd', value: '4' },
      ],
    });
  });

  it('getVar reads vars first, then props', async () => {
    const outcome = await run(
      'pre',
      `tc.setVar('tenant', 'beta'); console.log(tc.getVar('tenant'), tc.getVar('baseUrl'), tc.getVar('missing'));`,
    );
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['beta https://shop.test undefined'] } });
  });

  it('a secret-named write is returned as a run value', async () => {
    const outcome = await run('pre', "tc.setVar('clientSecret', 'shh', 'global');");
    expect(outcome).toMatchObject({ ok: true, values: [{ name: 'clientSecret', value: 'shh', secret: false }] });
  });

  it('replaceVars resolves {{name}} through vars, then props, and keeps an unknown name', async () => {
    const outcome = await run(
      'pre',
      `tc.setVar('id', '9');
       console.log(tc.replaceVars('{{baseUrl}}/p/{{id}}/{{nope}}'));`,
    );
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['https://shop.test/p/9/{{nope}}'] } });
  });
});

describe('the Thunder Client layer: run control', () => {
  it('skipRequest with no argument skips the current request', async () => {
    expect(await run('pre', 'tc.skipRequest();')).toMatchObject({ ok: true, control: { skip: true } });
  });

  it('skipRequest with a name is unsupported', async () => {
    expect(await run('pre', "tc.skipRequest('Login');")).toMatchObject({
      ok: false,
      error: { code: 'script-unsupported', message: expect.stringContaining('tc.skipRequest') as unknown },
    });
  });
});

describe('the Thunder Client layer: request', () => {
  it('the getters read the typed request', async () => {
    const outcome = await run(
      'pre',
      `console.log(tc.request.method, tc.request.url, tc.request.name, tc.request.getHeader('content-type'),
        tc.request.headers['Content-Type'], JSON.stringify(tc.request.body));`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      log: { lines: ['POST https://shop.test/graphql Product by id application/json application/json {"item":"a"}'] },
    });
  });

  it('the setters change the request before it is sent', async () => {
    const outcome = await run(
      'pre',
      `tc.request.setHeader('X-Trace', 't1'); tc.request.setBody({ item: 'b' }); tc.setParam('page', '2');
       console.log(tc.request.getHeader('X-Trace'), JSON.stringify(tc.request.body));`,
    );
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['t1 {"item":"b"}'] } });
  });

  it('a setter in a post-request script fails', async () => {
    const outcome = await run('post', "tc.request.setHeader('X-Trace', 't1');");
    expect(outcome.ok).toBe(false);
  });
});

describe('the Thunder Client layer: response and tests', () => {
  it('response has status, json, text, headers and time', async () => {
    const outcome = await run(
      'post',
      `tc.test('shape', () => {
         expect(tc.response.status).to.equal(200);
         tc.expect(tc.response.json.data.product.name).to.equal('Ada');
         expect(tc.response.text).to.include('Ada');
         expect(tc.response.headers['x-id']).to.equal('7');
         expect(tc.response.getHeader('X-Id')).to.equal('7');
         expect(tc.response.time).to.equal(42);
       });`,
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'shape', passed: true }] });
  });

  it('json is undefined for a response that is not JSON', async () => {
    const outcome = await run('post', 'console.log(String(tc.response.json), tc.response.text);', {
      response: { ...RESPONSE, headers: [['Content-Type', 'text/plain']], text: 'plain' },
    });
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['undefined plain'] } });
  });

  it('a failing check is a failed test, not a failed run', async () => {
    const outcome = await run('post', 'tc.test("bad", () => { expect(tc.response.status).to.equal(500); });');
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'bad', passed: false }] });
  });
});

describe('the Thunder Client layer: unsupported calls', () => {
  it.each([
    ['tc.runRequest', "tc.runRequest('r-1');"],
    ['tc.retryRequest', 'tc.retryRequest();'],
    ['tc.loadModule', "tc.loadModule('m');"],
    ['tc.loadFromPath', "tc.loadFromPath('./m.js');"],
    ['tc.readFile', "tc.readFile('./a.txt');"],
    ['tc.exec', "tc.exec('ls');"],
    ['tc.delay', 'tc.delay(100);'],
    ['require("thunder-tests/...")', "const lib = require('thunder-tests/lib.js');"],
    ['require', "const fs = require('fs');"],
  ])('%s fails with script-unsupported', async (name, source) => {
    const outcome = await run('pre', source);
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'script-unsupported', message: expect.stringContaining(name) as unknown },
    });
  });

  it('the scan names each call once, and plain require does not double-report', () => {
    const text = [
      "tc.runRequest('r'); tc.retryRequest(); tc.loadModule('m'); tc.loadFromPath('p');",
      "tc.readFile('f'); tc.exec('ls'); tc.delay(1); tc.skipRequest('Login');",
      "require('thunder-tests/lib.js');",
    ].join('\n');
    expect(unsupportedCalls(text, 'thunder-client')).toEqual([
      'tc.runRequest',
      'tc.retryRequest',
      'tc.loadModule',
      'tc.loadFromPath',
      'tc.readFile',
      'tc.exec',
      'tc.delay',
      'tc.skipRequest with a request name',
      'require("thunder-tests/...")',
    ]);
    expect(
      unsupportedCalls('require(\'thunder-tests/a.js\'); require("thunder-tests/b.js");', 'thunder-client'),
    ).toEqual(['require("thunder-tests/...")']);
    expect(unsupportedCalls("require('fs');", 'thunder-client')).toEqual(['require']);
    expect(unsupportedCalls("require('fs'); require('thunder-tests/a.js');", 'thunder-client')).toEqual([
      'require("thunder-tests/...")',
      'require',
    ]);
  });

  it('the scan ignores names that only look like calls and calls with no argument', () => {
    expect(
      unsupportedCalls('atc.runRequest(); x.tc.exec(); mytc.delay(1); tc.skipRequest();', 'thunder-client'),
    ).toEqual([]);
    expect(unsupportedCalls('const tc2 = 1; tc.setVar("a", 1); tc.test("t", () => {});', 'thunder-client')).toEqual([]);
  });

  it('tc.skipRequest() with no argument is the run control the scan reports', () => {
    expect(runControlCalls('tc.skipRequest();', 'thunder-client')).toEqual(['tc.skipRequest']);
    expect(runControlCalls("tc.skipRequest('Login');", 'thunder-client')).toEqual([]);
    expect(runControlCalls('xtc.skipRequest()', 'thunder-client')).toEqual([]);
  });
});
