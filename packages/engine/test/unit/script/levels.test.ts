/**
 * The scripts of the levels above a request (#334), through the real sandbox and checker: the order
 * they run in, a pre-request failure stopping the chain and a post-response one not, values carried
 * from one script to the next, each level reading only its own secrets, and the generic types an
 * outer level is checked against.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../src/rest/scripting.js';
import { scriptSession } from '../../../src/run/script-support.js';
import { createScriptChecker } from '../../../src/script/check/host.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { containerScriptLevels } from '../../../src/script/levels.js';
import { RequestScripting, type ScriptedRequest } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

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

const scripts = (extra: Partial<RequestScripts>): RequestScripts => ({
  api: 'wirebench',
  enabled: true,
  secrets: [],
  ...extra,
});

function scripted(
  levels: { api?: RequestScripts; folder?: RequestScripts; request?: RequestScripts },
  generated = '',
): ScriptedRequest {
  return {
    protocol: 'rest',
    path: 'Shop/Orders/List carts',
    name: 'List carts',
    slug: 'List carts',
    ...(levels.request !== undefined ? { scripts: levels.request } : {}),
    outer: [
      ...(levels.api !== undefined ? [{ level: 'api' as const, name: 'Shop', stem: 'api', scripts: levels.api }] : []),
      ...(levels.folder !== undefined
        ? [{ level: 'folder' as const, name: 'Orders', stem: 'Orders/folder', scripts: levels.folder }]
        : []),
    ],
    types: { generated },
  };
}

const VALUES = { vars: {}, props: {}, secrets: { k_api: 'api-secret', k_folder: 'folder-secret' } };

describe('level scripts', () => {
  it('run API, then folder, then request, each on the request the one before handed back', async () => {
    const session = scriptSession(
      scripting,
      scripted({
        api: scripts({ pre: { text: 'request.headers.set("X-Order", "api"); log("api pre");' } }),
        folder: scripts({
          pre: {
            text: 'request.headers.set("X-Order", request.headers.get("X-Order") + ",folder"); log("folder pre");',
          },
        }),
        request: scripts({
          pre: { text: 'request.headers.set("X-Order", request.headers.get("X-Order") + ",request");' },
          post: { text: 'log("request post");' },
        }),
      }),
      VALUES,
    );
    const sent = await session.pre(REQUEST);
    expect(sent.headers).toEqual([['X-Order', 'api,folder,request']]);

    const done = await session.post(sent, RESPONSE);
    expect(done.log.lines).toEqual(['api pre', 'folder pre', 'request post']);
    expect(done.levels.map((l) => [l.level, l.name, l.phase])).toEqual([
      ['api', 'Shop', 'pre'],
      ['folder', 'Orders', 'pre'],
      ['request', 'List carts', 'pre'],
      ['request', 'List carts', 'post'],
    ]);
    expect(done.levels[0]?.log.lines).toEqual(['api pre']);
  });

  it('stop at the first failing pre-request script, naming its file', async () => {
    const session = scriptSession(
      scripting,
      scripted({
        api: scripts({ pre: { text: 'throw new Error("no token");' } }),
        folder: scripts({ pre: { text: 'log("folder pre");' } }),
      }),
      VALUES,
    );
    await expect(session.pre(REQUEST)).rejects.toMatchObject({
      code: 'script-error',
      message: expect.stringContaining('api.pre.ts') as unknown,
    });
  });

  it('run every post-response script when one fails, and report the first failure', async () => {
    const session = scriptSession(
      scripting,
      scripted({
        api: scripts({ post: { text: 'test("api", () => expect(1).toBe(1)); throw new Error("api broke");' } }),
        folder: scripts({ post: { text: 'throw new Error("folder broke");' } }),
        request: scripts({ post: { text: 'test("request", () => expect(response.status).toBe(200));' } }),
      }),
      VALUES,
    );
    const done = await session.post(REQUEST, RESPONSE);
    expect(done.tests.map((t) => t.name)).toEqual(['api', 'request']);
    expect(done.error?.message).toContain('api.post.ts');
    expect(done.error?.message).toContain('api broke');
    expect(done.levels.map((l) => l.error?.message ?? 'ok')).toEqual([
      expect.stringContaining('api broke'),
      expect.stringContaining('Orders/folder.post.ts'),
      'ok',
    ]);
  });

  it('hand each value a script sets to every script after it', async () => {
    const session = scriptSession(
      scripting,
      scripted({
        api: scripts({ pre: { text: 'vars.set("token", "t-1");' } }),
        folder: scripts({ post: { text: 'vars.set("seen", String(vars.get("token")));' } }),
        request: scripts({ post: { text: 'log(String(vars.get("seen")));' } }),
      }),
      VALUES,
    );
    const done = await session.post(await session.pre(REQUEST), RESPONSE);
    expect(done.log.lines).toEqual(['t-1']);
    expect(done.values.map((v) => v.name)).toEqual(['token', 'seen']);
  });

  it('give each level only the secrets it lists', async () => {
    const session = scriptSession(
      scripting,
      scripted({
        api: scripts({ secrets: ['k_api'], pre: { text: 'log(secrets.get("k_api"));' } }),
        folder: scripts({ secrets: ['k_folder'], pre: { text: 'log(secrets.get("k_api"));' } }),
      }),
      VALUES,
    );
    await expect(session.pre(REQUEST)).rejects.toMatchObject({ code: 'script-secret-denied' });
  });

  it('run a request’s levels when the request has no scripts of its own', async () => {
    const session = scriptSession(
      scripting,
      scripted({ api: scripts({ post: { text: 'test("api", () => expect(response.status).toBe(200));' } }) }),
      VALUES,
    );
    const done = await session.post(await session.pre(REQUEST), RESPONSE);
    expect(done.tests).toEqual([{ name: 'api', passed: true }]);
  });

  describe('check', () => {
    const GENERATED = 'declare const onlyThisOperation: number;\n';

    it('checks a request’s own script against its own types, and a level against the generic ones', async () => {
      await expect(
        scripting.check(
          scripted({ request: scripts({ pre: { text: 'log(String(onlyThisOperation));' } }) }, GENERATED),
        ),
      ).resolves.toBeUndefined();
      await expect(
        scripting.check(scripted({ folder: scripts({ pre: { text: 'log(String(onlyThisOperation));' } }) }, GENERATED)),
      ).rejects.toMatchObject({
        code: 'script-type-error',
        message: expect.stringContaining('Orders/folder.pre.ts:1:') as unknown,
      });
    });

    it('refuses a level whose file is missing, naming the level', async () => {
      await expect(
        scripting.check(scripted({ api: scripts({ pre: { text: '', problem: 'script-file-missing' } }) })),
      ).rejects.toMatchObject({
        code: 'script-file-missing',
        message: expect.stringContaining('API "Shop"') as unknown,
      });
    });
  });
});

describe('containerScriptLevels', () => {
  const on = scripts({ pre: { text: 'log("x");' } });

  it('lists the container, then each scripted folder, its stem the folder path inside the container', () => {
    expect(
      containerScriptLevels({ name: 'Hello', scripts: on }, 'api', [
        { name: 'Greeter', slug: 'Greeter', scripts: on },
        { name: 'Plain', slug: 'Plain' },
        { name: 'Deep', slug: 'Deep', scripts: on },
      ]).map((level) => [level.level, level.name, level.stem]),
    ).toEqual([
      ['api', 'Hello', 'api'],
      ['folder', 'Greeter', 'Greeter/folder'],
      ['folder', 'Deep', 'Greeter/Plain/Deep/folder'],
    ]);
  });

  it('names a SOAP interface’s level as an interface', () => {
    expect(containerScriptLevels({ name: 'Stock', scripts: on }, 'interface')).toEqual([
      { level: 'interface', name: 'Stock', stem: 'interface', scripts: on },
    ]);
  });
});
