/**
 * Scripts in an imported collection (#63, #334): kept at the level Postman runs them from — the
 * collection's on the API, a folder's on its folder, a request's on the request — written for the
 * Postman layer and switched off, with the summary saying so and naming the calls Wirebench does not
 * run.
 */
import { describe, expect, it } from 'vitest';
import { runControlCalls, unsupportedCalls } from '../../../../src/import/scripts.js';
import { apiFromPostmanCollection } from '../../../../src/rest/postman/map.js';
import { parsePostmanCollection } from '../../../../src/rest/postman/parse.js';

const info = { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };
const script = (listen: string, exec: string | string[], extra: Record<string, unknown> = {}) => ({
  listen,
  script: { type: 'text/javascript', exec, ...extra },
});

const collection = {
  info,
  event: [script('prerequest', ['// collection pre']), script('test', "pm.test('ok', () => {});")],
  item: [
    {
      name: 'Auth',
      event: [script('prerequest', 'pm.sendRequest("https://x.test", () => {});')],
      item: [
        {
          name: 'Log in',
          event: [
            script('test', [
              'const t = pm.response.json().token;',
              "pm.environment.set('token', t);",
              'if (!t) pm.execution.setNextRequest(null);',
            ]),
          ],
          request: { method: 'POST', url: '/login' },
        },
      ],
    },
    { name: 'Plain', request: { method: 'GET', url: '/plain' } },
    {
      name: 'Off',
      event: [
        script('test', 'pm.test("x", () => {});', { disabled: true }),
        { listen: 'other', script: { exec: 'x' } },
      ],
      request: { method: 'GET', url: '/off' },
    },
  ],
};

describe('imported Postman scripts', () => {
  const { api, summary } = apiFromPostmanCollection(parsePostmanCollection(collection));
  const auth = api.folders[0];
  const login = auth?.requests[0];
  const off = { api: 'postman', enabled: false, secrets: [] } as const;

  it("puts the collection's scripts on the API, switched off", () => {
    expect(api.scripts).toEqual({
      pre: { text: '// collection pre\n' },
      post: { text: "pm.test('ok', () => {});\n" },
      ...off,
    });
  });

  it("puts a folder's scripts on the folder, and a request's on the request", () => {
    expect(auth?.scripts).toEqual({ pre: { text: 'pm.sendRequest("https://x.test", () => {});\n' }, ...off });
    expect(login?.scripts).toEqual({
      post: {
        text: "const t = pm.response.json().token;\npm.environment.set('token', t);\nif (!t) pm.execution.setNextRequest(null);\n",
      },
      ...off,
    });
  });

  it("copies no level's scripts into a request", () => {
    expect(api.requests.find((r) => r.name === 'Plain')?.scripts).toBeUndefined();
  });

  it('leaves out a disabled script and one of another kind', () => {
    expect(api.requests.find((r) => r.name === 'Off')?.scripts).toBeUndefined();
  });

  it('says the scripts are switched off, and names the calls that will not run', () => {
    expect(summary.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Scripts on the API, 1 folder and 1 request were imported switched off/),
        'The scripts of "Auth" call pm.sendRequest, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token',
        'The scripts of "Auth / Log in" steer the run (pm.execution.setNextRequest): obeyed in API and folder runs only',
      ]),
    );
    expect(summary.warnings?.some((w) => w.includes('were not imported'))).toBe(false);
  });

  it('joins two scripts of one kind on one level, in order', () => {
    const twice = apiFromPostmanCollection(
      parsePostmanCollection({
        info,
        event: [script('prerequest', 'a();'), script('prerequest', 'b();')],
        item: [{ name: 'R', request: { method: 'GET', url: '/r' } }],
      }),
    );
    expect(twice.api.scripts?.pre?.text).toBe('a();\n\nb();\n');
  });

  it('imports a collection with no scripts without any', () => {
    const bare = apiFromPostmanCollection(
      parsePostmanCollection({ info, item: [{ name: 'R', request: { method: 'GET', url: '/r' } }] }),
    );
    expect(bare.api.scripts).toBeUndefined();
    expect(bare.api.requests[0]?.scripts).toBeUndefined();
    expect(bare.summary.warnings ?? []).toEqual([]);
  });
});

describe('unsupportedCalls', () => {
  it('finds the calls the layer does not run', () => {
    expect(
      unsupportedCalls(
        "pm.sendRequest(x); pm.cookies.jar(); postman.setNextRequest('a'); require('lodash'); pm.visualizer.set(t); pm.execution.setNextRequest(null)",
        'postman',
      ).sort(),
    ).toEqual(['pm.cookies.jar', 'pm.sendRequest', 'pm.visualizer', 'require']);
    expect(unsupportedCalls('pm.test("a", () => pm.expect(1).to.equal(1));', 'postman')).toEqual([]);
  });

  it('names other unsupported calls in their own warning beside pm.sendRequest', () => {
    const both = apiFromPostmanCollection(
      parsePostmanCollection({
        info,
        item: [
          {
            name: 'R',
            event: [script('prerequest', 'pm.sendRequest("u", () => {}); pm.cookies.jar();')],
            request: { method: 'GET', url: '/r' },
          },
        ],
      }),
    );
    expect(both.summary.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^The scripts of "R" call pm\.sendRequest, which a script cannot do/),
        'The scripts of "R" call what Wirebench does not run: pm.cookies.jar',
      ]),
    );
  });
});

describe('runControlCalls', () => {
  it('finds the calls that steer a run', () => {
    expect(
      runControlCalls(
        "pm.execution.setNextRequest('a'); postman.setNextRequest(null); pm.execution.skipRequest(); pm.test('x', () => {});",
      ).sort(),
    ).toEqual(['pm.execution.setNextRequest', 'pm.execution.skipRequest', 'postman.setNextRequest']);
    expect(runControlCalls('pm.sendRequest(x);')).toEqual([]);
  });
});
