/**
 * The Postman layer (#63): the calls imported collections mostly make, run in the sandbox over the
 * typed API, and a clear `script-unsupported` for the ones Wirebench does not run.
 */
import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
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
  url: 'https://shop.test/login?x=1',
  headers: [['Content-Type', 'application/json']],
  body: { kind: 'text', text: '{"user":"a"}', language: 'json' },
};
const RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 200,
  statusText: 'OK',
  headers: [['Content-Type', 'application/json']],
  text: '{"token":"tok-1","user":{"id":7,"roles":["admin"]},"items":[1,2,3]}',
  durationMs: 42,
};

const run = (
  phase: 'pre' | 'post',
  source: string,
  extra: { vars?: Record<string, string> } = {},
): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase,
    api: 'postman',
    source,
    filename: `Login.${phase}.js`,
    request: REQUEST,
    ...(phase === 'post' ? { response: RESPONSE } : {}),
    vars: extra.vars ?? {},
    props: { baseUrl: 'https://shop.test' },
    secrets: {},
    requestName: 'Login',
  });

describe('the Postman layer', () => {
  it('runs typical test scripts', async () => {
    const outcome = await run(
      'post',
      `
      pm.test('Status code is 200', function () { pm.response.to.have.status(200); });
      pm.test('is ok', () => { pm.response.to.be.ok; });
      pm.test('has a token', () => {
        const json = pm.response.json();
        pm.expect(json).to.have.property('token');
        pm.expect(json.token).to.be.a('string').and.not.empty;
        pm.expect(json.user.id).to.equal(7);
        pm.expect(json.user.roles).to.include('admin');
        pm.expect(json.items).to.have.lengthOf(3);
        pm.expect(json).to.deep.include({ token: 'tok-1' });
        pm.expect(json.missing).to.be.undefined;
        pm.expect(pm.response.responseTime).to.be.below(1000);
      });
      pm.test('header', () => { pm.response.to.have.header('Content-Type'); pm.expect(pm.response.headers.get('content-type')).to.match(/json/); });
      pm.test('fails', () => { pm.expect(1).to.eql(2); });
      pm.environment.set('token', pm.response.json().token);
      pm.collectionVariables.set('userId', pm.response.json().user.id);
      console.log('base', pm.variables.get('baseUrl'), pm.info.requestName, pm.info.eventName);
    `,
    );
    expect(outcome).toMatchObject({
      ok: true,
      tests: [
        { name: 'Status code is 200', passed: true },
        { name: 'is ok', passed: true },
        { name: 'has a token', passed: true },
        { name: 'header', passed: true },
        { name: 'fails', passed: false, message: 'expected 1 to deeply equal 2' },
      ],
      values: [
        { name: 'token', value: 'tok-1', secret: false },
        { name: 'userId', value: '7', secret: false },
      ],
      log: { lines: ['base https://shop.test Login test'] },
    });
  });

  it('changes the request before it is sent', async () => {
    const outcome = await run(
      'pre',
      `
      pm.request.headers.upsert({ key: 'X-Trace', value: pm.variables.get('trace') });
      pm.request.headers.add({ key: 'X-Sig', value: CryptoJS.HmacSHA256(pm.request.body.raw, 'k').toString() });
      pm.request.headers.remove('Content-Type');
      pm.request.body.raw = JSON.stringify({ user: 'b' });
      pm.request.url.query.upsert({ key: 'x', value: '2' });
      pm.environment.set('stamp', 'now');
    `,
      { vars: { trace: 't-1' } },
    );
    expect(outcome).toMatchObject({
      ok: true,
      request: {
        url: 'https://shop.test/login?x=2',
        headers: [
          ['X-Trace', 't-1'],
          ['X-Sig', createHmac('sha256', 'k').update('{"user":"a"}').digest('hex')],
        ],
        body: { kind: 'text', text: '{"user":"b"}' },
      },
      values: [{ name: 'stamp', value: 'now' }],
    });
  });

  it('computes CryptoJS hashes and encodings, btoa and atob', async () => {
    const outcome = await run(
      'post',
      `
      pm.test('sha256', () => pm.expect(CryptoJS.SHA256('abc').toString()).to.equal('${createHmac('sha256', '').update('').digest('hex').length === 64 ? 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' : ''}'));
      pm.test('base64 of text', () => pm.expect(CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('hi'))).to.equal('aGk='));
      pm.test('hmac base64', () => pm.expect(CryptoJS.HmacSHA256('d', 'k').toString(CryptoJS.enc.Base64)).to.equal('${createHmac('sha256', 'k').update('d').digest('base64')}'));
      pm.test('btoa', () => pm.expect(atob(btoa('x:y'))).to.equal('x:y'));
    `,
    );
    expect(outcome.ok ? outcome.tests.map((t) => [t.name, t.passed, t.message]) : outcome).toEqual([
      ['sha256', true, undefined],
      ['base64 of text', true, undefined],
      ['hmac base64', true, undefined],
      ['btoa', true, undefined],
    ]);
  });

  it('refuses what it does not run, naming the call', async () => {
    for (const [source, name] of [
      ['pm.sendRequest("https://x.test", () => {});', 'pm.sendRequest'],
      ['pm.cookies.jar();', 'pm.cookies.jar'],
      ['postman.setNextRequest("x");', 'postman.setNextRequest'],
      ['require("lodash");', 'require'],
      ['pm.execution.setNextRequest(null);', 'pm.execution.setNextRequest'],
    ] as const) {
      expect(await run('post', source)).toMatchObject({
        ok: false,
        error: { code: 'script-unsupported', message: expect.stringContaining(name) as unknown },
      });
    }
  });

  it('keeps legacy postman variable calls working', async () => {
    const outcome = await run(
      'post',
      "postman.setEnvironmentVariable('a', 'b'); console.log(postman.getEnvironmentVariable('a'));",
    );
    expect(outcome).toMatchObject({ ok: true, values: [{ name: 'a', value: 'b' }], log: { lines: ['b'] } });
  });
});
