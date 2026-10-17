/**
 * The order post-response scripts run in across the API, folder and request levels: outermost
 * first unless the API's scripts say `inner-first`. Pre-request scripts never change order, and
 * only the API level's setting counts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../src/rest/scripting.js';
import { scriptSession } from '../../../src/run/script-support.js';
import { createScriptChecker } from '../../../src/script/check/host.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { RequestScripting, type ScriptedRequest } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';

const sandbox = createScriptSandbox();
const checker = createScriptChecker();
afterAll(async () => {
  await sandbox.dispose();
  await checker.dispose();
});
const scripting = new RequestScripting({ sandbox, checker });

const REQUEST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'GET',
  url: 'https://shop.test/carts',
  headers: [],
  body: { kind: 'none' },
};
const RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 200,
  statusText: 'OK',
  headers: [],
  text: '{}',
  durationMs: 3,
};
const VALUES = { vars: {}, props: {}, secrets: {} };

const logging = (name: string, extra: Partial<RequestScripts> = {}): RequestScripts => ({
  api: 'wirebench',
  enabled: true,
  secrets: [],
  pre: { text: `log("${name} pre");` },
  post: { text: `log("${name} post");` },
  ...extra,
});

function scripted(api: RequestScripts, folder: RequestScripts, request: RequestScripts): ScriptedRequest {
  return {
    protocol: 'rest',
    path: 'Shop/Orders/List carts',
    name: 'List carts',
    slug: 'List carts',
    scripts: request,
    outer: [
      { level: 'api', name: 'Shop', stem: 'api', scripts: api },
      { level: 'folder', name: 'Orders', stem: 'Orders/folder', scripts: folder },
    ],
    types: { generated: '' },
  };
}

async function run(request: ScriptedRequest) {
  const session = scriptSession(scripting, request, VALUES);
  const sent = await session.pre(REQUEST);
  return { pre: sent, done: await session.post(sent, RESPONSE) };
}

describe('post-response order', () => {
  it('inner-first runs request, folder, api post scripts in that order', async () => {
    const { done } = await run(
      scripted(logging('api', { postResponseOrder: 'inner-first' }), logging('folder'), logging('request')),
    );
    expect(done.log.lines.filter((line) => line.endsWith('post'))).toEqual(['request post', 'folder post', 'api post']);
    expect(done.levels.filter((l) => l.phase === 'post').map((l) => l.level)).toEqual(['request', 'folder', 'api']);
  });

  it('pre-request order never changes', async () => {
    const { done } = await run(
      scripted(logging('api', { postResponseOrder: 'inner-first' }), logging('folder'), logging('request')),
    );
    expect(done.log.lines.filter((line) => line.endsWith('pre'))).toEqual(['api pre', 'folder pre', 'request pre']);
  });

  it('no setting runs outer-first', async () => {
    const { done } = await run(scripted(logging('api'), logging('folder'), logging('request')));
    expect(done.log.lines.filter((line) => line.endsWith('post'))).toEqual(['api post', 'folder post', 'request post']);
    const explicit = await run(
      scripted(logging('api', { postResponseOrder: 'outer-first' }), logging('folder'), logging('request')),
    );
    expect(explicit.done.log.lines.filter((line) => line.endsWith('post'))).toEqual([
      'api post',
      'folder post',
      'request post',
    ]);
  });

  it('only the api level’s setting counts', async () => {
    const { done } = await run(
      scripted(
        logging('api'),
        logging('folder', { postResponseOrder: 'inner-first' }),
        logging('request', { postResponseOrder: 'inner-first' }),
      ),
    );
    expect(done.log.lines.filter((line) => line.endsWith('post'))).toEqual(['api post', 'folder post', 'request post']);
  });

  it('inner-first reports the errors of the scripts in the order they ran', async () => {
    const failing = (name: string): RequestScripts =>
      logging(name, { post: { text: `throw new Error("${name} broke");` } });
    const { done } = await run(scripted(failing('api'), failing('folder'), failing('request')));
    expect(done.error?.message).toContain('api broke');
    const inner = await run(
      scripted({ ...failing('api'), postResponseOrder: 'inner-first' }, failing('folder'), failing('request')),
    );
    expect(inner.done.error?.message).toContain('request broke');
  });

  it('check reports the post-response errors innermost first when the api says so', async () => {
    const broken = (name: string, extra: Partial<RequestScripts> = {}): RequestScripts => ({
      api: 'wirebench',
      enabled: true,
      secrets: [],
      post: { text: `const ${name}: number = "x";` },
      ...extra,
    });
    const files = async (request: ScriptedRequest): Promise<string> => {
      try {
        await scripting.check(request);
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    const outer = await files(scripted(broken('a'), broken('f'), broken('r')));
    expect(outer.indexOf('api.post.ts')).toBeLessThan(outer.indexOf('List carts.post.ts'));
    const inner = await files(scripted(broken('a', { postResponseOrder: 'inner-first' }), broken('f'), broken('r')));
    expect(inner.indexOf('List carts.post.ts')).toBeLessThan(inner.indexOf('api.post.ts'));
  });
});
