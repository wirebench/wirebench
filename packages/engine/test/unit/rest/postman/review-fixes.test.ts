import { describe, expect, it } from 'vitest';
import { PostmanError } from '../../../../src/errors.js';
import { importPostmanCollection } from '../../../../src/rest/postman/import.js';
import { apiFromPostmanCollection } from '../../../../src/rest/postman/map.js';
import type { PostmanCollection, PostmanItem } from '../../../../src/rest/postman/model.js';
import {
  normalizePostmanPath,
  parsePostmanCollection,
  translatePostmanVariables,
} from '../../../../src/rest/postman/parse.js';

const info = { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' };

function importDoc(doc: Record<string, unknown>) {
  return apiFromPostmanCollection(parsePostmanCollection({ info, ...doc }));
}

describe('Postman importer review fixes', () => {
  it('1: falls back to request.description when the item has none', () => {
    const { api } = importDoc({
      item: [{ name: 'R', request: { method: 'GET', url: '/x', description: 'from request' } }],
    });
    expect(api.requests[0]?.description).toBe('from request');
  });

  it('2: skips items without a usable request and warns with a count', () => {
    const { api, summary } = importDoc({
      item: [{ name: 'Empty' }, { name: 'Bad', request: 42 }, { name: 'Ok', request: '/ok' }],
    });
    expect(api.requests.map((r) => r.name)).toEqual(['Ok']);
    expect(summary.requests).toBe(1);
    expect(summary.warnings?.some((w) => w.includes('2 items'))).toBe(true);
  });

  it('3: strips a baseUrl variable prefix case-insensitively', () => {
    const { api } = importDoc({
      variable: [{ key: 'baseURL', value: 'https://api.example.com' }],
      item: [{ name: 'R', request: { method: 'GET', url: '{{baseURL}}/users' } }],
    });
    expect(api.requests[0]?.url).toBe('/users');
  });

  it('3: warns about collection and item variables that are not imported', () => {
    const { summary } = importDoc({
      variable: [
        { key: 'baseUrl', value: 'https://a' },
        { key: 'token', value: 't' },
      ],
      item: [{ name: 'F', variable: [{ key: 'folderVar', value: '1' }], item: [] }],
    });
    const w = summary.warnings?.find((x) => x.includes('token'));
    expect(w).toBeDefined();
    expect(w).toContain('folderVar');
    expect(w).not.toContain('baseUrl');
  });

  it('4: embeds GraphQL variables as an object and adds a JSON content type', () => {
    const { api } = importDoc({
      item: [
        {
          name: 'G',
          request: {
            method: 'POST',
            url: '/graphql',
            body: { mode: 'graphql', graphql: { query: 'query { a }', variables: '{"id": 1}' } },
          },
        },
        {
          name: 'Bad vars',
          request: {
            method: 'POST',
            url: '/graphql',
            body: { mode: 'graphql', graphql: { query: 'q', variables: '{' } },
          },
        },
      ],
    });
    const [good, bad] = api.requests;
    expect(good?.body.kind === 'raw' && JSON.parse(good.body.text)).toEqual({
      query: 'query { a }',
      variables: { id: 1 },
    });
    expect(good?.headers).toContainEqual({ name: 'Content-Type', value: 'application/json', enabled: true });
    expect(bad?.body.kind === 'raw' && JSON.parse(bad.body.text)).toEqual({ query: 'q', variables: {} });
  });

  it('5: throws postman-too-deep for 10k nested folders instead of overflowing the stack', async () => {
    const depth = 10_000;
    const text = `{"info":{"name":"Deep"},"item":[${'{"name":"f","item":['.repeat(depth)}${']}'.repeat(depth)}]}`;
    const error = await importPostmanCollection({ kind: 'text', text }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PostmanError);
    expect((error as PostmanError).code).toBe('postman-too-deep');
  });

  it('5: the mapper also refuses a too-deep collection built in memory', () => {
    let item: PostmanItem = { name: 'leaf', request: '/x' };
    for (let i = 0; i < 100; i += 1) item = { name: 'f', item: [item] };
    const collection: PostmanCollection = { info: { name: 'Deep' }, item: [item] };
    expect(() => apiFromPostmanCollection(collection)).toThrow(expect.objectContaining({ code: 'postman-too-deep' }));
  });

  it('5: rejects text input larger than the size cap', async () => {
    const text = ' '.repeat(50 * 1024 * 1024 + 1);
    await expect(importPostmanCollection({ kind: 'text', text })).rejects.toThrow(
      expect.objectContaining({ code: 'postman-too-large' }),
    );
  });

  it('6: escapes a literal ${ so it does not become a live property', () => {
    expect(translatePostmanVariables('cost: ${price} {{x}}')).toBe('cost: $${price} ${x}');
  });

  it('6: allows inner spaces in variable names', () => {
    expect(translatePostmanVariables('{{my var}}')).toBe('${my var}');
  });

  it('6: warns about dynamic variables', () => {
    const { summary } = importDoc({
      item: [{ name: 'R', request: { method: 'GET', url: '/x?id={{$guid}}' } }],
    });
    expect(summary.warnings?.some((w) => w.includes('$guid'))).toBe(true);
  });

  it('7: ignores a disabled Content-Type header when detecting the body language', () => {
    const { api } = importDoc({
      item: [
        {
          name: 'R',
          request: {
            method: 'POST',
            url: '/x',
            header: [{ key: 'Content-Type', value: 'application/xml', disabled: true }],
            body: { mode: 'raw', raw: '{"a":1}' },
          },
        },
      ],
    });
    expect(api.requests[0]?.body).toMatchObject({ kind: 'raw', language: 'json' });
  });

  it('7: converts a path parameter followed by a dot', () => {
    expect(normalizePostmanPath('/files/:id.json')).toBe('/files/{id}.json');
  });

  it('7: does not emit path params for url variables that are not in the path', () => {
    const { api } = importDoc({
      item: [
        {
          name: 'R',
          request: {
            method: 'GET',
            url: {
              raw: '/users/:id',
              variable: [
                { key: 'id', value: '1' },
                { key: 'stale', value: '2' },
              ],
            },
          },
        },
      ],
    });
    expect(api.requests[0]?.pathParams.map((p) => p.name)).toEqual(['id']);
  });

  it('7: keeps every src of a multi-file formdata part', () => {
    const { api } = importDoc({
      item: [
        {
          name: 'R',
          request: {
            method: 'POST',
            url: '/u',
            body: { mode: 'formdata', formdata: [{ key: 'files', type: 'file', src: ['a.png', 'b.png'] }] },
          },
        },
      ],
    });
    const body = api.requests[0]?.body;
    expect(body?.kind === 'multipart' && body.parts.map((p) => (p.kind === 'file' ? p.source : undefined))).toEqual([
      { kind: 'path', path: 'a.png' },
      { kind: 'path', path: 'b.png' },
    ]);
  });

  it('7: warns when scripts are dropped and when credentials must be re-entered', () => {
    const { summary } = importDoc({
      event: [{ listen: 'prerequest', script: { exec: ['1'] } }],
      auth: { type: 'bearer', bearer: [{ key: 'token', value: 'secret' }] },
      item: [{ name: 'R', event: [{ listen: 'test', script: { exec: ['2'] } }], request: '/x' }],
    });
    expect(summary.warnings?.some((w) => /script/i.test(w) && w.includes('2'))).toBe(true);
    expect(summary.warnings?.some((w) => /re-enter/i.test(w))).toBe(true);
  });

  it('7: translates variables inside variable values', () => {
    const parsed = parsePostmanCollection({ info, item: [], variable: [{ key: 'url', value: '{{host}}/v1' }] });
    expect(parsed.variable?.[0]?.value).toBe('${host}/v1');
  });
});
