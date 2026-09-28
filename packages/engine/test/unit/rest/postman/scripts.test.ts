/**
 * Scripts in an imported collection (#63): kept, concatenated collection → folder → request in the
 * order Postman runs them, written for the Postman layer and switched off, with the summary saying
 * so and naming the calls Wirebench does not run.
 */
import { describe, expect, it } from 'vitest';
import { apiFromPostmanCollection, unsupportedCalls } from '../../../../src/rest/postman/map.js';
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
          event: [script('test', ['const t = pm.response.json().token;', "pm.environment.set('token', t);"])],
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
  const login = api.folders[0]?.requests[0];

  it('concatenates collection, folder and request scripts in order, switched off', () => {
    expect(login?.scripts).toEqual({
      pre: {
        text: '// --- From the collection "Shop" ---\n// collection pre\n\n// --- From the folder "Auth" ---\npm.sendRequest("https://x.test", () => {});\n',
      },
      post: {
        text: "// --- From the collection \"Shop\" ---\npm.test('ok', () => {});\n\n// --- From the request ---\nconst t = pm.response.json().token;\npm.environment.set('token', t);\n",
      },
      api: 'postman',
      enabled: false,
      secrets: [],
    });
  });

  it("gives a request the collection's scripts even when it has none of its own", () => {
    const plain = api.requests.find((r) => r.name === 'Plain');
    expect(plain?.scripts?.pre?.text).toContain('collection pre');
    expect(plain?.scripts?.enabled).toBe(false);
  });

  it('leaves out a disabled script and one of another kind', () => {
    const off = api.requests.find((r) => r.name === 'Off');
    expect(off?.scripts?.post?.text).not.toContain('pm.test("x"');
  });

  it('says the scripts are switched off, and names the calls that will not run', () => {
    expect(summary.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Scripts on 3 requests were imported switched off/),
        'The scripts of "Auth / Log in" call what Wirebench does not run: pm.sendRequest',
      ]),
    );
    expect(summary.warnings?.some((w) => w.includes('were not imported'))).toBe(false);
  });

  it('imports a collection with no scripts without any', () => {
    const bare = apiFromPostmanCollection(
      parsePostmanCollection({ info, item: [{ name: 'R', request: { method: 'GET', url: '/r' } }] }),
    );
    expect(bare.api.requests[0]?.scripts).toBeUndefined();
    expect(bare.summary.warnings ?? []).toEqual([]);
  });
});

describe('unsupportedCalls', () => {
  it('finds the calls the layer does not run', () => {
    expect(
      unsupportedCalls(
        "pm.sendRequest(x); pm.cookies.jar(); postman.setNextRequest('a'); require('lodash'); pm.visualizer.set(t); pm.execution.setNextRequest(null)",
      ).sort(),
    ).toEqual([
      'pm.cookies.jar',
      'pm.execution.setNextRequest',
      'pm.sendRequest',
      'pm.visualizer',
      'postman.setNextRequest',
      'require',
    ]);
    expect(unsupportedCalls('pm.test("a", () => pm.expect(1).to.equal(1));')).toEqual([]);
  });
});
