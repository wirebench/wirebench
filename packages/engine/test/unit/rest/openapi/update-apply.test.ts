/**
 * Update Definition's apply half for a REST API: generated fields follow the new document only while
 * they still equal what the old document generated; nothing is ever deleted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RestApi, RestFolder, RestRequestDef } from '../../../../src/rest/model.js';
import { parseOpenApi } from '../../../../src/rest/openapi/import.js';
import { apiFromDocument } from '../../../../src/rest/openapi/map.js';
import type { OpenApiDocument, OpenApiOperation } from '../../../../src/rest/openapi/model.js';
import { applyRestUpdate, planRestUpdate } from '../../../../src/rest/openapi/update.js';

const updateDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/update/', import.meta.url));

async function load(name: string): Promise<OpenApiDocument> {
  const text = readFileSync(`${updateDir}${name}`, 'utf-8');
  const parsed = await parseOpenApi(
    { kind: 'text', text },
    { fetchDocument: () => Promise.reject(new Error('no fetch expected')) },
  );
  return parsed.document;
}

function doc(operations: OpenApiOperation[], extra: Partial<OpenApiDocument> = {}): OpenApiDocument {
  return {
    version: '3.0',
    declaredVersion: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://a.test' }],
    operations,
    securitySchemes: [],
    tags: [],
    skipped: [],
    ...extra,
  };
}

const op = (extra: Partial<OpenApiOperation> = {}): OpenApiOperation => ({
  method: 'get',
  path: '/pets',
  parameters: [],
  ...extra,
});

let counter = 0;
const ids = (): string => `id-${++counter}`;

function imported(document: OpenApiDocument): RestApi {
  return apiFromDocument(document, {
    newId: ids,
    definition: { source: 'x', cache: true, version: document.declaredVersion },
  }).api;
}

function all(api: RestApi): RestRequestDef[] {
  const walk = (f: RestFolder): RestRequestDef[] => [...f.requests, ...f.folders.flatMap(walk)];
  return [...api.requests, ...api.folders.flatMap(walk)];
}

function find(api: RestApi, method: string, path: string): RestRequestDef {
  const found = all(api).find((r) => r.contract?.method === method && r.contract.path === path);
  if (found === undefined) throw new Error(`no request for ${method} ${path}`);
  return found;
}

function edit(api: RestApi, id: string, change: (r: RestRequestDef) => RestRequestDef): RestApi {
  const mapReq = (r: RestRequestDef): RestRequestDef => (r.id === id ? change(r) : r);
  const mapFolder = (f: RestFolder): RestFolder => ({
    ...f,
    folders: f.folders.map(mapFolder),
    requests: f.requests.map(mapReq),
  });
  return { ...api, requests: api.requests.map(mapReq), folders: api.folders.map(mapFolder) };
}

describe('applyRestUpdate', () => {
  it('SC-1: an untouched request follows a changed parameter, body sample and path template', () => {
    const old = doc([
      op({
        method: 'post',
        path: '/pets/{id}',
        parameters: [
          { name: 'id', in: 'path', required: true, example: '1' },
          { name: 'limit', in: 'query' },
        ],
        requestBody: { content: { 'application/json': { example: { a: 1 } } } },
      }),
    ]);
    const next = doc([
      op({
        method: 'post',
        path: '/pets/{id}',
        parameters: [
          { name: 'id', in: 'path', required: true, example: '2' },
          { name: 'limit', in: 'query', required: true },
        ],
        requestBody: { content: { 'application/json': { example: { a: 2 } } } },
      }),
    ]);
    const api = imported(old);
    const result = applyRestUpdate(api, old, next, { newId: ids });
    const req = find(result.api, 'post', '/pets/{id}');
    expect(req.pathParams).toEqual([{ name: 'id', value: '2', enabled: true }]);
    expect(req.query).toEqual([{ name: 'limit', value: '', enabled: true }]);
    expect(req.body).toEqual({ kind: 'raw', language: 'json', text: JSON.stringify({ a: 2 }, null, 2) });
    expect(result.requestsRewritten).toBe(1);
    expect(result.requestsAdded).toBe(0);
  });

  it('SC-1: an edited url is kept', () => {
    const old = doc([op()]);
    const next = doc([op({ parameters: [{ name: 'q', in: 'query', example: '1' }] })]);
    let api = imported(old);
    api = edit(api, find(api, 'get', '/pets').id, (r) => ({ ...r, url: '/v2/pets?mine=1' }));
    const result = applyRestUpdate(api, old, next);
    const req = find(result.api, 'get', '/pets');
    expect(req.url).toBe('/v2/pets?mine=1');
    expect(req.query).toEqual([{ name: 'q', value: '1', enabled: false }]);
  });

  it('does not write back an absent base URL or server list as an undefined key', () => {
    const old = doc([op()]);
    const { baseUrl, servers, ...bare } = imported(old);
    void baseUrl;
    void servers;
    const result = applyRestUpdate(bare as RestApi, old, doc([op()])).api;
    expect(Object.keys(result)).not.toContain('baseUrl');
    expect(Object.keys(result)).not.toContain('servers');
    expect(Object.keys(result)).not.toContain('auth');
  });

  it('follows only the first of two untouched rows with the same name', () => {
    const old = doc([op({ parameters: [{ name: 'a', in: 'query', example: '1' }] })]);
    const next = doc([op({ parameters: [{ name: 'a', in: 'query', example: '2' }] })]);
    let api = imported(old);
    api = edit(api, find(api, 'get', '/pets').id, (r) => ({ ...r, query: [r.query[0]!, r.query[0]!] }));
    const result = applyRestUpdate(api, old, next);
    expect(find(result.api, 'get', '/pets').query).toEqual([
      { name: 'a', value: '2', enabled: false },
      { name: 'a', value: '1', enabled: false },
    ]);
  });

  it('SC-2: an edited parameter value, body and auth are kept; user rows are kept', () => {
    const old = doc([
      op({
        method: 'post',
        parameters: [
          { name: 'limit', in: 'query', example: 1 },
          { name: 'X-Trace', in: 'header', example: 'a' },
        ],
        requestBody: { content: { 'application/json': { example: { a: 1 } } } },
      }),
    ]);
    const next = doc([
      op({
        method: 'post',
        parameters: [
          { name: 'limit', in: 'query', example: 5 },
          { name: 'x-trace', in: 'header', example: 'b' },
        ],
        requestBody: { content: { 'application/json': { example: { a: 2 } } } },
        security: [],
      }),
    ]);
    let api = imported(old);
    const id = find(api, 'post', '/pets').id;
    api = edit(api, id, (r) => ({
      ...r,
      query: [
        { ...r.query[0]!, value: '99' },
        { name: 'mine', value: 'x', enabled: true },
      ],
      body: { kind: 'raw', language: 'json', text: '{"edited":true}' },
      auth: { type: 'bearer' },
    }));
    const result = applyRestUpdate(api, old, next);
    const req = find(result.api, 'post', '/pets');
    expect(req.query).toEqual([
      { name: 'limit', value: '99', enabled: false },
      { name: 'mine', value: 'x', enabled: true },
    ]);
    // The header row was untouched, and matches case-insensitively: it follows.
    expect(req.headers).toEqual([{ name: 'x-trace', value: 'b', enabled: false }]);
    expect(req.body).toEqual({ kind: 'raw', language: 'json', text: '{"edited":true}' });
    expect(req.auth).toEqual({ type: 'bearer' });
  });

  it('auth follows when untouched, including from absent to explicit none', () => {
    const old = doc([op()]);
    const next = doc([op({ security: [] })]);
    const result = applyRestUpdate(imported(old), old, next);
    expect(find(result.api, 'get', '/pets').auth).toEqual({ type: 'none' });
  });

  it('appends a new generated row, removes an untouched dropped one, keeps an edited dropped one', () => {
    const old = doc([
      op({
        parameters: [
          { name: 'a', in: 'query', example: '1' },
          { name: 'b', in: 'query', example: '1' },
        ],
      }),
    ]);
    const next = doc([op({ parameters: [{ name: 'c', in: 'query', example: '3' }] })]);
    let api = imported(old);
    api = edit(api, find(api, 'get', '/pets').id, (r) => ({
      ...r,
      query: [r.query[0]!, { ...r.query[1]!, enabled: true }],
    }));
    const result = applyRestUpdate(api, old, next);
    expect(find(result.api, 'get', '/pets').query).toEqual([
      { name: 'b', value: '1', enabled: true },
      { name: 'c', value: '3', enabled: false },
    ]);
    expect(result.rowsAdded).toBe(1);
    expect(result.rowsRemoved).toBe(1);
  });

  it('SC-3: a removed operation is orphaned and kept; restoring it clears the flag', () => {
    const old = doc([op(), op({ method: 'delete' })]);
    const next = doc([op()]);
    const first = applyRestUpdate(imported(old), old, next);
    expect(find(first.api, 'delete', '/pets').orphaned).toBe(true);
    expect(first.requestsOrphaned).toBe(1);
    expect(all(first.api)).toHaveLength(2);

    const again = applyRestUpdate(first.api, next, next);
    expect(again.requestsOrphaned).toBe(0);

    const back = applyRestUpdate(first.api, next, old);
    expect(find(back.api, 'delete', '/pets').orphaned).toBeUndefined();
    expect(back.requestsRestored).toBe(1);
    expect(back.requestsAdded).toBe(0);
  });

  it('leaves a request with no contract alone', () => {
    const old = doc([op()]);
    const next = doc([]);
    let api = imported(old);
    api = edit(api, find(api, 'get', '/pets').id, (r) => {
      const { contract, ...rest } = r;
      void contract;
      return rest;
    });
    const result = applyRestUpdate(api, old, next);
    expect(result.api).toEqual(api);
    expect(result.requestsOrphaned).toBe(0);
  });

  it('SC-4: new operations go into their tag folder, created once for two', () => {
    const old = doc([op()]);
    const next = doc(
      [
        op(),
        op({ path: '/owners', summary: 'List owners', tags: ['owners'] }),
        op({ method: 'post', path: '/owners', summary: 'Add owner', tags: ['owners'] }),
        op({ path: '/health', summary: 'Health' }),
      ],
      { tags: [{ name: 'owners', description: 'Pet owners' }] },
    );
    const api = imported(old);
    const result = applyRestUpdate(api, old, next, { newId: ids });
    const owners = result.api.folders.filter((f) => f.name === 'owners');
    expect(owners).toHaveLength(1);
    expect(owners[0]!.requests.map((r) => r.name)).toEqual(['List owners', 'Add owner']);
    expect(owners[0]!.description).toBe('Pet owners');
    expect(result.api.folders.find((f) => f.name === 'health')?.requests.map((r) => r.name)).toEqual(['Health']);
    expect(result.requestsAdded).toBe(3);
    // The existing folder gets the next request, with a unique slug and order.
    const pets = result.api.folders.find((f) => f.name === 'pets')!;
    expect(pets.requests).toHaveLength(1);
  });

  it('puts a new operation into an existing folder of that name, with a unique slug', () => {
    const old = doc([op({ summary: 'List' })]);
    const next = doc([op({ summary: 'List' }), op({ method: 'post', summary: 'List' })]);
    const result = applyRestUpdate(imported(old), old, next);
    const pets = result.api.folders.filter((f) => f.name === 'pets');
    expect(pets).toHaveLength(1);
    expect(pets[0]!.requests.map((r) => r.slug)).toEqual(['List', 'List-2']);
    expect(pets[0]!.requests.map((r) => r.order)).toEqual([0, 1]);
  });

  it('counts an operation a hand-made request already covers instead of adding a second', () => {
    const old = doc([op({ summary: 'List' })]);
    const next = doc([op({ summary: 'List' }), op({ method: 'post', summary: 'Add' })]);
    const api = imported(old);
    // The user made the POST themselves before the update arrived.
    const mine: RestRequestDef = {
      ...find(api, 'get', '/pets'),
      id: ids(),
      slug: 'mine',
      name: 'Mine',
      method: 'POST',
      contract: { method: 'post', path: '/pets' },
    };
    const withMine: RestApi = { ...api, requests: [...api.requests, mine] };

    const plan = planRestUpdate(old, next);
    expect(plan.added.map((a) => `${a.method} ${a.path}`)).toEqual(['post /pets']);
    const result = applyRestUpdate(withMine, old, next, { newId: ids });
    expect(result.requestsAdded).toBe(0);
    // What the plan listed under Added and apply did not make: the toast can say so.
    expect(result.requestsAlreadyPresent).toBe(1);
    expect(all(result.api).filter((r) => r.contract?.method === 'post')).toHaveLength(1);
  });

  it('puts a new operation into a renamed tag folder instead of making a twin', () => {
    const old = doc([op({ path: '/owners', summary: 'List owners', tags: ['owners'] })]);
    const next = doc([
      op({ path: '/owners', summary: 'List owners', tags: ['owners'] }),
      op({ method: 'post', path: '/owners', summary: 'Add owner', tags: ['owners'] }),
    ]);
    const api = imported(old);
    // The user renamed the tag folder; nothing on it still says "owners".
    const renamed: RestApi = {
      ...api,
      folders: api.folders.map((folder) => ({ ...folder, name: 'Pet owners', slug: 'Pet-owners' })),
    };
    const result = applyRestUpdate(renamed, old, next, { newId: ids });
    expect(result.api.folders.map((f) => f.name)).toEqual(['Pet owners']);
    expect(result.api.folders[0]!.requests.map((r) => r.name)).toEqual(['List owners', 'Add owner']);
  });

  it('prefers the tag folder by name over one the user moved a request into', () => {
    const old = doc([
      op({ path: '/owners', summary: 'List owners', tags: ['owners'] }),
      op({ path: '/owners/{id}', summary: 'One owner', tags: ['owners'] }),
    ]);
    const next = doc([
      ...old.operations,
      op({ method: 'post', path: '/owners', summary: 'Add owner', tags: ['owners'] }),
    ]);
    const api = imported(old);
    const moved = find(api, 'get', '/owners/{id}');
    // The user dragged one of the tag's requests into a folder of their own.
    const rearranged: RestApi = {
      ...api,
      folders: [
        ...api.folders.map((folder) => ({ ...folder, requests: folder.requests.filter((r) => r.id !== moved.id) })),
        { id: 'mine', name: 'Favourites', slug: 'Favourites', order: 9, folders: [], requests: [moved] },
      ],
    };
    const result = applyRestUpdate(rearranged, old, next, { newId: ids });
    expect(result.api.folders.find((f) => f.name === 'Favourites')!.requests.map((r) => r.name)).toEqual(['One owner']);
    expect(result.api.folders.find((f) => f.name === 'owners')!.requests.map((r) => r.name)).toEqual([
      'List owners',
      'Add owner',
    ]);
  });

  it('API level: base URL, servers and auth follow while untouched; version is updated', () => {
    const scheme = { name: 'k', type: 'apiKey' as const, in: 'header' as const, keyName: 'X-Key' };
    const old = doc([op()], { securitySchemes: [scheme], security: [{ k: [] }] });
    const next = doc([op()], {
      declaredVersion: '3.1.0',
      servers: [{ url: 'https://b.test' }],
      securitySchemes: [{ ...scheme, keyName: 'X-New' }],
      security: [{ k: [] }],
    });
    const followed = applyRestUpdate(imported(old), old, next).api;
    expect(followed.baseUrl).toBe('https://b.test');
    expect(followed.servers).toEqual([{ url: 'https://b.test' }]);
    expect(followed.auth).toEqual({ type: 'api-key', name: 'X-New', in: 'header' });
    expect(followed.definition?.version).toBe('3.1.0');

    const edited: RestApi = { ...imported(old), baseUrl: 'http://localhost', auth: { type: 'basic' } };
    const kept = applyRestUpdate(edited, old, next).api;
    expect(kept.baseUrl).toBe('http://localhost');
    expect(kept.auth).toEqual({ type: 'basic' });
    expect(kept.servers).toEqual([{ url: 'https://b.test' }]);
  });

  it('agrees with the plan on the fixtures: every added op gets a request, every removed op is orphaned', async () => {
    const old = await load('petstore-update-old.yaml');
    const next = await load('petstore-update-next.yaml');
    const plan = planRestUpdate(old, next);
    const api = imported(old);
    const result = applyRestUpdate(api, old, next, { newId: ids });
    for (const added of plan.added) {
      expect(find(result.api, added.method, added.path).orphaned).toBeUndefined();
    }
    for (const removed of plan.removed) {
      expect(find(result.api, removed.method, removed.path).orphaned).toBe(true);
    }
    expect(result.requestsAdded).toBe(plan.added.length);
    expect(result.requestsOrphaned).toBe(plan.removed.length);
    expect(result.api.baseUrl).toBe('https://v2.pets.test');
    expect(all(result.api)).toHaveLength(all(api).length + plan.added.length);
    expect(result.api.folders.filter((f) => f.name === 'owners')).toHaveLength(1);
    // The untouched list request follows the now-required limit.
    expect(find(result.api, 'get', '/pets').query[0]?.enabled).toBe(true);
  });
});
