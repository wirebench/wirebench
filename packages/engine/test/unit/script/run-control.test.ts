/**
 * Run control from scripts (#335, ADR-0016 update of 2026-10-11): `execution.setNextRequest` and
 * `execution.skipRequest` hand back a checked directive and nothing else. No host function is
 * reached, and a forged directive is refused like any other forged output.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RestRequestSnapshot, RestResponseSnapshot } from '#protocol-rest/rest/scripting';
import { ScriptSkipped, scriptSession } from '#core/run/script-support';
import type { RequestScripts, ScriptOutcome } from '#core/script/model';
import { runScript, type ScriptRunInput } from '#core/script/run';
import { createScriptSandbox } from '#core/script/sandbox/host';
import { levelScriptTypes, RequestScripting, type ScriptedRequest } from '#core/script/request-scripts';
import { scriptDeclarations } from '#core/script/types/api';
import { typeErrors } from './ts-check.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const REQUEST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'GET',
  url: 'https://shop.test/status',
  headers: [],
  body: { kind: 'none' },
};
const RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 200,
  statusText: 'OK',
  headers: [],
  text: '{"ready":false}',
  durationMs: 3,
};

const run = (phase: 'pre' | 'post', source: string, extra: Partial<ScriptRunInput> = {}): Promise<ScriptOutcome> =>
  runScript({
    sandbox,
    phase,
    api: 'wirebench',
    source,
    filename: `Poll.${phase}.ts`,
    request: REQUEST,
    ...(phase === 'post' ? { response: RESPONSE } : {}),
    vars: {},
    props: {},
    secrets: {},
    requestName: 'Poll',
    ...extra,
  });

const postman = (phase: 'pre' | 'post', source: string): Promise<ScriptOutcome> =>
  run(phase, source, { api: 'postman', filename: `Poll.${phase}.js` });

describe('execution in a typed script', () => {
  it('hands back no control when the script steers nothing', async () => {
    const outcome = await run('post', 'vars.set("a", "1");');
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.ok && outcome.control).toBeUndefined();
  });

  it('hands back the next request, the last call winning', async () => {
    expect(await run('post', 'execution.setNextRequest("Login"); execution.setNextRequest("Poll");')).toMatchObject({
      ok: true,
      control: { next: 'Poll' },
    });
  });

  it('hands back null to end the run', async () => {
    expect(await run('post', 'execution.setNextRequest(null);')).toMatchObject({ ok: true, control: { next: null } });
  });

  it('hands back a skip from a pre-request script, with the request unchanged', async () => {
    const outcome = await run('pre', 'execution.skipRequest(); execution.setNextRequest("Done");');
    expect(outcome).toMatchObject({ ok: true, control: { skip: true, next: 'Done' } });
  });

  it('refuses a skip in a post-response script', async () => {
    expect(await run('post', 'execution.skipRequest();')).toMatchObject({
      ok: false,
      error: { code: 'script-unsupported', message: expect.stringContaining('pre-request') as unknown },
    });
  });

  it('refuses a name that is not a string, or is too long', async () => {
    for (const source of [
      'execution.setNextRequest(42 as unknown as string);',
      'execution.setNextRequest({ name: "x" } as unknown as string);',
      'execution.setNextRequest(undefined as unknown as string);',
      `execution.setNextRequest("${'x'.repeat(257)}");`,
    ]) {
      expect(await run('post', source)).toMatchObject({ ok: false, error: { code: 'script-value-invalid' } });
    }
  });

  it('hands back no control from a script that failed after steering', async () => {
    const outcome = await run('post', 'execution.setNextRequest("Login"); throw new Error("boom");');
    expect(outcome).toMatchObject({ ok: false, error: { code: 'script-error' } });
    expect('control' in outcome).toBe(false);
  });

  it('cannot reassign execution', async () => {
    const outcome = await run(
      'post',
      '(globalThis as any).execution = { setNextRequest() {} }; execution.setNextRequest("A");',
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'script-error' } });
  });
});

describe('a forged directive', () => {
  const forge = (control: string): Promise<ScriptOutcome> =>
    run('post', `(globalThis as any).__finish = () => ({ tests: [], values: [], control: ${control} });`);

  it('is refused with an unknown key', async () => {
    expect(await forge('{ next: "A", host: "evil.test" }')).toMatchObject({
      ok: false,
      error: { code: 'script-error' },
    });
  });

  it('is refused with a non-string next', async () => {
    expect(await forge('{ next: 7 }')).toMatchObject({ ok: false, error: { code: 'script-error' } });
    expect(await forge('{ next: ["A"] }')).toMatchObject({ ok: false, error: { code: 'script-error' } });
  });

  it('is refused with an over-long next', async () => {
    expect(await forge(`{ next: "${'x'.repeat(257)}" }`)).toMatchObject({ ok: false, error: { code: 'script-error' } });
  });

  it('is refused with a non-boolean skip, or a skip after the response', async () => {
    expect(await forge('{ skip: "yes" }')).toMatchObject({ ok: false, error: { code: 'script-error' } });
    expect(await forge('{ skip: true }')).toMatchObject({ ok: false, error: { code: 'script-error' } });
  });

  it('is refused when it is not an object', async () => {
    expect(await forge('"Login"')).toMatchObject({ ok: false, error: { code: 'script-error' } });
    expect(await forge('JSON.parse(\'{"__proto__": {"next": "A"}}\')')).toMatchObject({
      ok: false,
      error: { code: 'script-error' },
    });
  });
});

describe('the Postman calls', () => {
  it('pm.execution.setNextRequest and postman.setNextRequest steer the run', async () => {
    expect(await postman('post', 'pm.execution.setNextRequest("Login");')).toMatchObject({
      ok: true,
      control: { next: 'Login' },
    });
    expect(await postman('post', 'postman.setNextRequest(null);')).toMatchObject({ ok: true, control: { next: null } });
  });

  it('pm.execution.skipRequest skips from a pre-request script', async () => {
    expect(await postman('pre', 'pm.execution.skipRequest();')).toMatchObject({ ok: true, control: { skip: true } });
  });

  it('pm.sendRequest is still refused', async () => {
    expect(await postman('pre', 'pm.sendRequest("https://x.test", () => {});')).toMatchObject({
      ok: false,
      error: { code: 'script-unsupported', message: expect.stringContaining('pm.sendRequest') as unknown },
    });
  });
});

describe('the execution types', () => {
  const declarations = (phase: 'pre' | 'post'): string =>
    scriptDeclarations('rest', phase, [], levelScriptTypes('rest'));

  it('accept a name, null and a skip', () => {
    const script = 'execution.setNextRequest("Login");\nexecution.setNextRequest(null);\nexecution.skipRequest();\n';
    expect(typeErrors(declarations('pre'), script)).toEqual([]);
  });

  it('refuse anything but a name or null', () => {
    expect(typeErrors(declarations('post'), 'execution.setNextRequest(42);\n')).toHaveLength(1);
  });
});

describe('the scripts of a send, and run control', () => {
  const scripting = new RequestScripting({ sandbox });
  const scripts = (pre?: string, post?: string): RequestScripts => ({
    api: 'wirebench',
    enabled: true,
    secrets: [],
    ...(pre !== undefined ? { pre: { text: pre } } : {}),
    ...(post !== undefined ? { post: { text: post } } : {}),
  });
  const scripted = (api: RequestScripts | undefined, own: RequestScripts): ScriptedRequest => ({
    protocol: 'rest',
    path: 'Shop/Poll',
    name: 'Poll',
    slug: 'Poll',
    scripts: own,
    outer: api !== undefined ? [{ level: 'api', name: 'Shop', stem: 'api', scripts: api }] : [],
    types: { generated: '' },
  });
  const VALUES = { vars: {}, props: {}, secrets: {} };

  it('in a run, stops the pre-request chain at a skip and carries the next request', async () => {
    const session = scriptSession(
      scripting,
      scripted(
        scripts('log("api"); execution.setNextRequest("Done"); execution.skipRequest();'),
        scripts('log("own");'),
      ),
      VALUES,
      { runControl: true },
    );
    const thrown = await session.pre(REQUEST).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ScriptSkipped);
    expect(thrown).toMatchObject({ next: 'Done', log: { lines: ['api'] } });
  });

  it('in a run, carries the last next request across levels and phases', async () => {
    const session = scriptSession(
      scripting,
      scripted(
        scripts('execution.setNextRequest("A");', 'execution.setNextRequest("B");'),
        scripts(undefined, 'execution.setNextRequest(null);'),
      ),
      VALUES,
      { runControl: true },
    );
    const sent = await session.pre(REQUEST);
    expect((await session.post(sent, RESPONSE)).control).toEqual({ next: null });
  });

  it('outside a run, ignores run control and logs that it did, once per call', async () => {
    const session = scriptSession(
      scripting,
      scripted(
        scripts('execution.skipRequest(); execution.setNextRequest("A");'),
        scripts('execution.skipRequest();', 'execution.setNextRequest("B");'),
      ),
      VALUES,
    );
    const sent = await session.pre(REQUEST);
    const done = await session.post(sent, RESPONSE);
    expect(done.control).toBeUndefined();
    expect(done.log.lines).toEqual([
      'execution.setNextRequest is obeyed only in an API or folder run; ignored here',
      'execution.skipRequest is obeyed only in an API or folder run; ignored here',
    ]);
  });
});
