/**
 * The Bruno layer: `bru`, `req`, `res` and `expect` (with `.jsonSchema`) over the typed script API;
 * the calls the sandbox cannot honour fail with `script-unsupported`, and the sandbox limits hold.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../src/rest/scripting.js';
import type { ScriptOutcome } from '../../../src/script/model.js';
import { runScript } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { SCRIPT_LIMITS } from '../../../src/script/sandbox/model.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const REQUEST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'POST',
  url: 'https://shop.test/orgs/42/users',
  headers: [['Content-Type', 'application/json']],
  body: { kind: 'text', text: '{"name":"Ada"}', language: 'json' },
};
const RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 201,
  statusText: 'Created',
  headers: [['Content-Type', 'application/json']],
  text: '{"id":7,"name":"Ada"}',
  durationMs: 42,
};

const run = (
  phase: 'pre' | 'post',
  source: string,
  extra: { vars?: Record<string, string>; response?: RestResponseSnapshot; timeoutMs?: number } = {},
): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase,
    api: 'bruno',
    source,
    filename: `Create user.${phase}.js`,
    request: REQUEST,
    ...(phase === 'post' ? { response: extra.response ?? RESPONSE } : {}),
    vars: extra.vars ?? {},
    props: { baseUrl: 'https://shop.test', tenant: 'acme' },
    secrets: {},
    requestName: 'Create user',
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
  });

describe('the Bruno layer: bru variables', () => {
  it('every getter reads vars first, then props', async () => {
    const outcome = await run(
      'pre',
      `bru.setVar('tenant', 'beta');
       console.log(bru.getVar('tenant'), bru.getEnvVar('tenant'), bru.getCollectionVar('baseUrl'),
         bru.getFolderVar('baseUrl'), bru.getRequestVar('baseUrl'), bru.getVar('missing'));`,
      {},
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [{ name: 'tenant', value: 'beta' }],
      log: { lines: ['beta beta https://shop.test https://shop.test https://shop.test undefined'] },
    });
  });

  it('setVar and setEnvVar write run values, read back in the post phase', async () => {
    const pre = await run('pre', "bru.setVar('startedAt', 123); bru.setEnvVar('token', 'tok-1');");
    expect(pre).toMatchObject({
      ok: true,
      values: [
        { name: 'startedAt', value: '123' },
        { name: 'token', value: 'tok-1' },
      ],
    });
    const post = await run('post', 'console.log(bru.getVar("token"), bru.getEnvVar("startedAt"));', {
      vars: { startedAt: '123', token: 'tok-1' },
    });
    expect(post).toMatchObject({ ok: true, log: { lines: ['tok-1 123'] } });
  });

  it('a secret-named write is returned as a run value', async () => {
    const outcome = await run('pre', "bru.setVar('clientSecret', 'shh'); bru.setEnvVar('apiPassword', 'pw');");
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'clientSecret', value: 'shh', secret: false },
        { name: 'apiPassword', value: 'pw', secret: false },
      ],
    });
  });
});

describe('the Bruno layer: run control', () => {
  it('bru.setNextRequest steers the run', async () => {
    expect(await run('post', "bru.setNextRequest('Login');")).toMatchObject({ ok: true, control: { next: 'Login' } });
  });

  it('bru.runner.skipRequest skips the request from a pre-request script', async () => {
    expect(await run('pre', 'bru.runner.skipRequest();')).toMatchObject({ ok: true, control: { skip: true } });
  });

  it('bru.runner.stopExecution ends the run', async () => {
    expect(await run('post', 'bru.runner.stopExecution();')).toMatchObject({ ok: true, control: { next: null } });
  });
});

describe('the Bruno layer: req', () => {
  it('reads the URL, method, headers and a JSON body', async () => {
    const outcome = await run(
      'pre',
      `console.log(req.getUrl(), req.getMethod(), req.getHeader('content-type'), JSON.stringify(req.getBody()));`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      log: { lines: ['https://shop.test/orgs/42/users POST application/json {"name":"Ada"}'] },
    });
  });

  it('changes the request in a pre-request script', async () => {
    const outcome = await run(
      'pre',
      `req.setUrl('https://shop.test/v2'); req.setMethod('PUT'); req.setHeader('X-Run', '1');
       req.deleteHeader('Content-Type'); req.setBody({ name: 'Grace' });`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      request: {
        method: 'PUT',
        url: 'https://shop.test/v2',
        headers: [['X-Run', '1']],
        body: { kind: 'text', text: '{"name":"Grace"}', language: 'json' },
      },
    });
  });

  it('setBody takes text as it is', async () => {
    const outcome = await run('pre', "req.setBody('plain');");
    expect(outcome).toMatchObject({ ok: true, request: { body: { kind: 'text', text: 'plain' } } });
  });
});

describe('the Bruno layer: res', () => {
  it('res.body is parsed JSON for a JSON response', async () => {
    const outcome = await run('post', 'console.log(typeof res.body, res.body.id, res.getBody().name);');
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['object 7 Ada'] } });
  });

  it('res.body is text for any other response', async () => {
    const outcome = await run('post', 'console.log(typeof res.body, res.body);', {
      response: { ...RESPONSE, headers: [['Content-Type', 'text/plain']], text: '{"id":7}' },
    });
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['string {"id":7}'] } });
  });

  it('res.body falls back to text when a JSON response does not parse', async () => {
    const outcome = await run('post', 'console.log(res.body);', { response: { ...RESPONSE, text: 'oops' } });
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['oops'] } });
  });

  it('exposes status, headers and responseTime, and the getters', async () => {
    const outcome = await run(
      'post',
      `console.log(res.status, res.getStatus(), res.responseTime, res.headers['Content-Type'] ?? res.headers['content-type'], res.getHeader('content-type'));`,
    );
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['201 201 42 application/json application/json'] } });
  });
});

describe('the Bruno layer: test and expect', () => {
  it('the tests block from a collection records a passing test', async () => {
    const outcome = await run(
      'post',
      `test("returns the created user", function() {
         expect(res.getStatus()).to.equal(201);
         expect(res.body).to.have.property('name', 'Ada');
       });`,
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'returns the created user', passed: true }] });
  });

  it('a failing expectation records a failed test', async () => {
    const outcome = await run('post', "test('status', () => { expect(res.getStatus()).to.equal(200); });");
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'status', passed: false }] });
  });

  it('.jsonSchema passes a value that matches', async () => {
    const outcome = await run(
      'post',
      `test('shape', () => expect(res.body).to.have.jsonSchema({
         type: 'object', required: ['id'], properties: { id: { type: 'integer' }, name: { type: 'string' } },
       }));`,
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: 'shape', passed: true }] });
  });

  it('.jsonSchema fails listing path, keyword and message', async () => {
    const outcome = await run(
      'post',
      `test('shape', () => expect(res.body).to.have.jsonSchema({
         type: 'object', properties: { id: { type: 'string' } },
       }));`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      tests: [{ name: 'shape', passed: false, message: expect.stringMatching(/\/id type: .*string/) as unknown }],
    });
  });

  it('.jsonSchema fails, naming the node cap, when the check cannot finish', async () => {
    const rows = Array.from({ length: 12_000 }, (_, i) => i);
    const outcome = await run(
      'post',
      `test('big', () => expect(res.body).to.have.jsonSchema({ type: 'array', items: { type: 'integer' } }));`,
      { response: { ...RESPONSE, text: JSON.stringify(rows) } },
    );
    expect(outcome).toMatchObject({
      ok: true,
      tests: [
        {
          name: 'big',
          passed: false,
          message: expect.stringMatching(/could not finish.*stopped after 10000 nodes/) as unknown,
        },
      ],
    });
  });
});

describe('the Bruno layer: unsupported calls', () => {
  it('fails each with script-unsupported naming the call', async () => {
    for (const [name, source] of [
      ['bru.interpolate', "bru.interpolate('{{baseUrl}}/x')"],
      ['bru.sendRequest', "bru.sendRequest({ url: 'https://x.test' })"],
      ['bru.sleep', 'bru.sleep(10)'],
      ['bru.cookies', 'bru.cookies.jar()'],
      ['req.setTimeout', 'req.setTimeout(500)'],
      ['require', "require('lodash')"],
    ] as const) {
      expect(await run('pre', source)).toMatchObject({
        ok: false,
        error: { code: 'script-unsupported', message: expect.stringContaining(name) as unknown },
      });
    }
  });
});

describe('the Bruno layer: sandbox limits (spec §10)', () => {
  it('stops a script that loops forever with script-timeout', async () => {
    expect(await run('pre', 'while (true) {}', { timeoutMs: 200 })).toMatchObject({
      ok: false,
      error: { code: 'script-timeout' },
    });
  });

  it('stops a script that exhausts memory with script-memory', { timeout: 20_000 }, async () => {
    expect(
      await run('pre', 'const a = []; while (true) { a.push("xxxxxxxxxxxxxxxx" + a.length); }', { timeoutMs: 10_000 }),
    ).toMatchObject({ ok: false, error: { code: 'script-memory' } });
  });

  it('cuts the log off at its cap', async () => {
    const outcome = await run(
      'pre',
      `for (let i = 0; i < ${String(SCRIPT_LIMITS.logLines + 50)}; i++) console.log(i);`,
    );
    expect(outcome).toMatchObject({ ok: true, log: { truncated: true } });
    expect(outcome.log.lines).toHaveLength(SCRIPT_LIMITS.logLines);
  });
});
