/**
 * The Insomnia layer: `insomnia` and `$` are the Postman `pm` object plus `baseEnvironment`,
 * `parentFolders` and `vault`; the calls the sandbox cannot honour fail with `script-unsupported`.
 */
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
  status: 201,
  statusText: 'Created',
  headers: [['Content-Type', 'application/json']],
  text: '{"token":"tok-1"}',
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
    api: 'insomnia',
    source,
    filename: `Login.${phase}.js`,
    request: REQUEST,
    ...(phase === 'post' ? { response: RESPONSE } : {}),
    vars: extra.vars ?? {},
    props: { baseUrl: 'https://shop.test' },
    secrets: {},
    requestName: 'Login',
  });

describe('the Insomnia layer', () => {
  it('insomnia.test and expect report a passing test', async () => {
    const outcome = await run(
      'post',
      "insomnia.test('201', () => insomnia.expect(insomnia.response.code).to.eql(201));",
    );
    expect(outcome).toMatchObject({ ok: true, tests: [{ name: '201', passed: true }] });
  });

  it('$ is insomnia', async () => {
    const outcome = await run(
      'post',
      "$.test('same object', () => $.expect($ === insomnia).to.equal(true)); $.test('201', () => $.expect($.response.code).to.equal(201));",
    );
    expect(outcome).toMatchObject({
      ok: true,
      tests: [
        { name: 'same object', passed: true },
        { name: '201', passed: true },
      ],
    });
  });

  it('insomnia.environment.set writes vars, read back in the post phase', async () => {
    const pre = await run('pre', "insomnia.variables.set('requestedAt', 'now'); insomnia.environment.set('a', 1);");
    expect(pre).toMatchObject({
      ok: true,
      values: [
        { name: 'requestedAt', value: 'now' },
        { name: 'a', value: '1' },
      ],
    });
    const post = await run(
      'post',
      "console.log(insomnia.environment.get('a'), insomnia.variables.get('requestedAt'));",
      {
        vars: { a: '1', requestedAt: 'now' },
      },
    );
    expect(post).toMatchObject({ ok: true, log: { lines: ['1 now'] } });
  });

  it('baseEnvironment.get reads props, and parentFolders too', async () => {
    const outcome = await run(
      'pre',
      "console.log(insomnia.baseEnvironment.get('baseUrl'), insomnia.baseEnvironment.has('nope'), insomnia.parentFolders.get('baseUrl'));",
    );
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['https://shop.test false https://shop.test'] } });
  });

  it('baseEnvironment and parentFolders writes go to vars, which win over props', async () => {
    const outcome = await run(
      'pre',
      "insomnia.baseEnvironment.set('baseUrl', 'https://other.test'); insomnia.parentFolders.set('folderVar', 'f'); console.log(insomnia.baseEnvironment.get('baseUrl'));",
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'baseUrl', value: 'https://other.test' },
        { name: 'folderVar', value: 'f' },
      ],
      log: { lines: ['https://other.test'] },
    });
  });

  it('a secret-named write stays in vars', async () => {
    const outcome = await run(
      'pre',
      "insomnia.baseEnvironment.set('clientSecret', 'shh'); insomnia.environment.set('apiPassword', 'pw');",
    );
    expect(outcome).toMatchObject({
      ok: true,
      values: [
        { name: 'clientSecret', value: 'shh', secret: false },
        { name: 'apiPassword', value: 'pw', secret: false },
      ],
    });
  });

  it('fails the calls the sandbox cannot honour with script-unsupported', async () => {
    for (const [name, source] of [
      ['insomnia.sendRequest', "insomnia.sendRequest('https://x.test', () => {})"],
      ['insomnia.require', "insomnia.require('lodash')"],
      ['require', "require('lodash')"],
      ['insomnia.vault', "insomnia.vault.get('secret')"],
      ['insomnia.cookies', "insomnia.cookies.set({ key: 'a', value: 'b' })"],
    ] as const) {
      expect(await run('post', source)).toMatchObject({
        ok: false,
        error: { code: 'script-unsupported', message: expect.stringContaining(name) as unknown },
      });
    }
  });

  it('reads cookies as empty, as the Postman layer does', async () => {
    const outcome = await run('post', "console.log(insomnia.cookies.has('a'), insomnia.cookies.get('a'));");
    expect(outcome).toMatchObject({ ok: true, log: { lines: ['false undefined'] } });
  });
});
