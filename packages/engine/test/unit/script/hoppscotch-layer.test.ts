/**
 * The Hoppscotch layer: `pw`, `hopp` and `pm` over the typed API. The `pw` and `hopp` scripts are the
 * ones in fixtures/hoppscotch/crafted (`legacy-v0.json`, `v12-r17.json`); the response shapes follow
 * Hoppscotch's own sandbox (`TestResponse` in hoppscotch-js-sandbox/src/types/index.ts: headers are a
 * list of `{ key, value }`, the body is the parsed JSON for a JSON content type).
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../src/rest/scripting.js';
import type { ScriptOutcome } from '../../../src/script/model.js';
import { runScript } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { runControlCalls, unsupportedCalls } from '../../../src/import/scripts.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const REQUEST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'POST',
  url: 'https://shop.test/orders?x=1',
  headers: [['Content-Type', 'application/json']],
  body: { kind: 'text', text: '{"item":"a"}', language: 'json' },
};
const RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 201,
  statusText: 'Created',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Id', '7'],
  ],
  text: '{"id":7,"tags":["a","b"]}',
  durationMs: 42,
};

const run = (
  phase: 'pre' | 'post',
  source: string,
  extra: { vars?: Record<string, string>; props?: Record<string, string> } = {},
): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase,
    api: 'hoppscotch',
    source,
    filename: `Order.${phase}.js`,
    request: REQUEST,
    ...(phase === 'post' ? { response: RESPONSE } : {}),
    vars: extra.vars ?? {},
    props: extra.props ?? { baseUrl: 'https://shop.test' },
    secrets: {},
    requestName: 'Order',
  });

describe('the Hoppscotch layer: pw', () => {
  it('runs the legacy-v0 fixture test', async () => {
    const outcome = await run('post', 'pw.test("ok", () => { pw.expect(pw.response.status).toBe(200) })');
    // The fixture asserts 200; this response is 201, so the test is reported as failed, not the run.
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'ok', passed: false }] });
    const ok = await run('post', 'pw.test("ok", () => { pw.expect(pw.response.status).toBe(201) })');
    expect(ok).toMatchObject({ ok: true, tests: [{ name: 'ok', passed: true }] });
  });

  it('pw.response.body is the parsed JSON for a JSON response, headers are { key, value } rows', async () => {
    const outcome = await run(
      'post',
      `pw.test('shape', () => {
        pw.expect(pw.response.body.id).toBe(7);
        pw.expect(pw.response.body.tags).toHaveLength(2);
        pw.expect(pw.response.headers.find((h) => h.key === 'X-Id').value).toBe('7');
      });`,
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'shape', passed: true }] });
  });

  it('pw.env get, set, unset and resolve read vars then props and write vars', async () => {
    const outcome = await run(
      'pre',
      `pw.env.set('a', 1);
       pw.env.set('b', pw.env.get('baseUrl'));
       console.log(pw.env.resolve('<<baseUrl>>/x/<<a>>/<<missing>>'));
       pw.env.unset('a');`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'a', value: '' },
        { name: 'b', value: 'https://shop.test' },
      ],
      log: { lines: ['https://shop.test/x/1/<<missing>>'] },
    });
  });

  it('pw.expect has the jest matchers and their .not', async () => {
    const outcome = await run(
      'post',
      `pw.test('matchers', () => {
        pw.expect(1).toBe(1);
        pw.expect(1).not.toBe(2);
        pw.expect('a').toBeType('string');
        pw.expect([1, 2]).toInclude(2);
        pw.expect('abc').toInclude('bc');
        pw.expect(201).toBeLevel2xx();
        pw.expect(404).toBeLevel4xx();
        pw.expect(500).toBeLevel5xx();
        pw.expect(301).toBeLevel3xx();
        pw.expect(201).not.toBeLevel4xx();
        pw.expect('ab').toHaveLength(2);
      });
      pw.test('wrong', () => pw.expect(201).toBeLevel4xx());
      pw.test('wrong not', () => pw.expect(1).not.toBe(1));`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      tests: [
        { name: 'matchers', passed: true },
        { name: 'wrong', passed: false },
        { name: 'wrong not', passed: false },
      ],
    });
  });

  it('pw.expect has no chai chain', async () => {
    const outcome = await run('post', "pw.test('chai', () => pw.expect(1).to.equal(1));");
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'chai', passed: false }] });
  });

  it('pw.response is undefined in the pre-request phase', async () => {
    const outcome = await run('pre', 'console.log(String(pw.response));');
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['undefined'] } });
  });
});

describe('the Hoppscotch layer: hopp', () => {
  it('runs the v12-r17 fixture scripts', async () => {
    const pre = await run('pre', "hopp.env.set('orderRef', 'A-1')");
    expect(pre).toMatchObject({ ok: true, values: [{ name: 'orderRef', value: 'A-1' }] });
    const post = await run('post', "hopp.test('created', () => { hopp.expect(hopp.response.statusCode).toBe(201) })");
    expect(post).toMatchObject({ ok: true, tests: [{ name: 'created', passed: true }] });
  });

  it('hopp.env get, getRaw, set, delete and the active and global scopes', async () => {
    const outcome = await run(
      'pre',
      `hopp.env.set('ts', '5');
       hopp.env.active.set('b', 'x');
       hopp.env.global.set('c', 'y');
       console.log(hopp.env.get('ts'), hopp.env.getRaw('baseUrl'), hopp.env.active.get('b'));
       hopp.env.delete('ts');`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'ts', value: '' },
        { name: 'b', value: 'x' },
        { name: 'c', value: 'y' },
      ],
      log: { lines: ['5 https://shop.test x'] },
    });
  });

  it('hopp.expect takes the chai chains and the jest matchers', async () => {
    const outcome = await run(
      'post',
      `hopp.test('both', () => {
        hopp.expect(hopp.response.statusCode).to.equal(201);
        hopp.expect(hopp.response.statusCode).toBe(201);
        hopp.expect(hopp.response.statusCode).not.toBe(200);
        hopp.expect(hopp.response.statusCode).not.to.equal(200);
        hopp.expect(hopp.response.statusCode).toBeLevel2xx();
      });
      hopp.test('chai wrong', () => hopp.expect(1).to.equal(2));
      hopp.test('jest wrong', () => hopp.expect(1).toBe(2));`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      tests: [
        { name: 'both', passed: true },
        { name: 'chai wrong', passed: false },
        { name: 'jest wrong', passed: false },
      ],
    });
  });

  it('assertions chained after .property(...) fail when wrong', async () => {
    const outcome = await run(
      'post',
      "hopp.test('wrong', () => hopp.expect({ a: 1 }).to.have.property('a').that.equals(5));",
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'wrong', passed: false }] });
  });

  it('hopp.response has statusCode, statusText, headers, responseTime and body.asJSON / asText', async () => {
    const outcome = await run(
      'post',
      `hopp.test('response', () => {
        hopp.expect(hopp.response.statusText).to.equal('Created');
        hopp.expect(hopp.response.responseTime).to.equal(42);
        hopp.expect(hopp.response.headers[0]).to.eql({ key: 'Content-Type', value: 'application/json' });
        hopp.expect(hopp.response.body.asJSON().id).to.equal(7);
        hopp.expect(hopp.response.body.asText()).to.equal('{"id":7,"tags":["a","b"]}');
      });`,
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'response', passed: true }] });
  });

  it('hopp.response.body.asJSON on a non-JSON body fails the test', async () => {
    const outcome = await runScript({
      sandbox,
      phase: 'post',
      api: 'hoppscotch',
      source: "hopp.test('json', () => hopp.response.body.asJSON());",
      filename: 'Order.post.js',
      request: REQUEST,
      response: { ...RESPONSE, headers: [['Content-Type', 'text/plain']], text: 'plain' },
      vars: {},
      props: {},
      secrets: {},
      requestName: 'Order',
    });
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'json', passed: false }] });
  });

  it('hopp.request reads and, before the request is sent, changes the request', async () => {
    const outcome = await run(
      'pre',
      `hopp.request.setUrl('https://shop.test/v2');
       hopp.request.setMethod('PUT');
       hopp.request.setHeader('X-Trace', 't1');
       hopp.request.setBody('{"item":"b"}');
       console.log(hopp.request.method, hopp.request.url);`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      log: { lines: ['PUT https://shop.test/v2'] },
      request: { method: 'PUT', url: 'https://shop.test/v2' },
    });
  });

  it('hopp.request setters fail in the post phase', async () => {
    for (const source of [
      "hopp.request.setUrl('https://x.test')",
      "hopp.request.setMethod('PUT')",
      "hopp.request.setHeader('X-A', '1')",
      "hopp.request.setBody('x')",
    ]) {
      const outcome = await run('post', source);
      expect(outcome).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('cannot be changed') as unknown },
      });
    }
    expect(await run('post', 'console.log(hopp.request.method)')).toMatchObject({
      ok: true,
      log: { lines: ['POST'] },
    });
  });

  it('a secret-named write is returned as a run value', async () => {
    const outcome = await run('pre', "hopp.env.set('clientSecret', 'shh'); pw.env.set('apiPassword', 'pw');");
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'clientSecret', value: 'shh', secret: false },
        { name: 'apiPassword', value: 'pw', secret: false },
      ],
    });
  });
});

describe('the Hoppscotch layer: pm', () => {
  it('pm.environment.set in a Hoppscotch script writes vars', async () => {
    const outcome = await run('pre', "pm.environment.set('a', 1); pm.variables.set('b', 'two');");
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'a', value: '1' },
        { name: 'b', value: 'two' },
      ],
    });
  });

  it('pm.test, pm.expect and pm.response work', async () => {
    const outcome = await run(
      'post',
      "pm.test('201', () => { pm.expect(pm.response.code).to.equal(201); pm.expect(pm.response.json().id).to.equal(7); });",
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: '201', passed: true }] });
  });
});

describe('the Hoppscotch layer: what it does not run', () => {
  it('fails each unsupported call with script-unsupported naming it', async () => {
    for (const [name, source] of [
      ['hopp.cookies', "hopp.cookies.get('a')"],
      ['hopp.fetch', "hopp.fetch('https://x.test')"],
      ['pm.sendRequest', "pm.sendRequest('https://x.test', () => {})"],
      ['pm.collectionVariables', "pm.collectionVariables.get('a')"],
      ['pm.iterationData', "pm.iterationData.get('a')"],
      ['pm.visualizer', "pm.visualizer.set('<p/>')"],
      ['pm.execution.setNextRequest', "pm.execution.setNextRequest('B')"],
      ['pm.execution.skipRequest', 'pm.execution.skipRequest()'],
      ['require', "require('lodash')"],
    ] as const) {
      expect(await run('post', source)).toMatchObject({
        ok: false,
        error: { code: 'script-unsupported', message: expect.stringContaining(name) as unknown },
      });
    }
  });

  it('a top-level import is a clear error, and nothing runs', async () => {
    const outcome = await run('pre', "import { x } from 'lib';\nhopp.env.set('ran', '1');");
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'script-unsupported', message: expect.stringContaining('import') as unknown },
    });
    expect(outcome.values).toEqual([]);
  });

  it('a leading export {}; module marker is ignored', async () => {
    const outcome = await run('pre', "export {};\nhopp.env.set('a', '1');");
    expect(outcome).toMatchObject({ ok: true, values: [{ name: 'a', value: '1' }] });
  });

  it('the scan lists the same calls, with no double report', () => {
    const text = [
      "hopp.cookies.get('a'); hopp.fetch('u'); pm.sendRequest('u'); pm.collectionVariables.get('a');",
      'pm.iterationData.get("a"); pm.visualizer.set("x"); pm.execution.setNextRequest("B"); pm.execution.skipRequest();',
      "require('x');",
      "import { x } from 'lib';",
    ].join('\n');
    expect(unsupportedCalls(text, 'hoppscotch')).toEqual([
      'hopp.cookies',
      'hopp.fetch',
      'pm.sendRequest',
      'pm.collectionVariables',
      'pm.iterationData',
      'pm.visualizer',
      'pm.execution.setNextRequest',
      'pm.execution.skipRequest',
      'require',
      'import',
    ]);
    expect(unsupportedCalls('ahopp.cookies.x; foo.hopp.fetch(1); // import x', 'hoppscotch')).toEqual([]);
    expect(unsupportedCalls("const s = 'important'; reimport(1);", 'hoppscotch')).toEqual([]);
  });

  it('Hoppscotch has no run control to warn about', () => {
    expect(runControlCalls('pm.execution.setNextRequest("B")', 'hoppscotch')).toEqual([]);
  });
});
