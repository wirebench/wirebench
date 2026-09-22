// @vitest-environment node
/**
 * `ProjectHost.restContractFor`: the operation a REST request calls and its declared responses,
 * read from the API's definition cache and memoised per API until the project closes.
 */
import { mkdtempSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultFetchDocument, importOpenApi } from '@wirebench/engine';
import type { RestApi, RestRequestDef } from '@wirebench/engine';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';

const DOCUMENT = `openapi: 3.0.3
info: { title: Pets, version: '1' }
servers: [{ url: 'https://pets.example.test/v1' }]
paths:
  /pets/{id}:
    get:
      operationId: getPet
      responses:
        '200':
          description: a pet
          content:
            application/json:
              schema: { type: object, required: [name], properties: { name: { type: string } } }
  /pets:
    post:
      responses:
        '201': { description: created }
`;

let dir: string;
let host: ProjectHost;

async function importPets(cache: boolean): Promise<{ api: RestApi; apiId: string }> {
  const imported = await importOpenApi(
    { kind: 'text', text: DOCUMENT, location: 'https://pets.example.test/openapi.yaml' },
    { fetchDocument: createDefaultFetchDocument() },
  );
  const { apiId } = await host.addApi({
    api: imported.api,
    documents: imported.documents,
    source: 'https://pets.example.test/openapi.yaml',
    declaredVersion: '3.0.3',
    cache,
  });
  const api = host.model()?.apis.find((candidate) => candidate.id === apiId) as RestApi;
  return { api, apiId };
}

function requestNamed(api: RestApi, method: string): RestRequestDef {
  const all = [...api.requests, ...api.folders.flatMap((folder) => folder.requests)];
  const found = all.find((request) => request.method === method);
  if (found === undefined) throw new Error(`no ${method} request`);
  return found;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-rest-contract-'));
  host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  await host.create({ dir: join(dir, 'project'), name: 'Pets' });
});

describe('ProjectHost.restContractFor', () => {
  it("answers a linked request's operation and its responses from the cache, memoised per API", async () => {
    const { api, apiId } = await importPets(true);
    const get = requestNamed(api, 'GET');
    const target = await host.restContractFor(get.id, { method: 'GET', url: get.url });
    expect(target?.operation).toEqual({ method: 'get', path: '/pets/{id}' });
    expect(Object.keys(target?.responses ?? {})).toEqual(['200']);
    expect(host.openApiDocumentFor(apiId)).toBe(host.openApiDocumentFor(apiId));
  });

  it('matches an unlinked request by method and URL', async () => {
    const { api, apiId } = await importPets(true);
    const before = new Set([...api.requests, ...api.folders.flatMap((folder) => folder.requests)].map((r) => r.id));
    await host.mutate({ kind: 'add-rest-request', apiId });
    const after = host.model()?.apis.find((candidate) => candidate.id === apiId) as RestApi;
    const added = [...after.requests, ...after.folders.flatMap((folder) => folder.requests)].find(
      (request) => !before.has(request.id),
    );
    expect(added?.contract).toBeUndefined();
    const target = await host.restContractFor(added?.id ?? '', {
      method: 'GET',
      url: 'https://pets.example.test/v1/pets/7',
    });
    expect(target?.operation).toEqual({ method: 'get', path: '/pets/{id}' });
  });

  it('has nothing for a request whose API has no cached definition, or no request at all', async () => {
    const { api } = await importPets(false);
    const get = requestNamed(api, 'GET');
    expect(host.restContractFor(get.id, { method: 'GET', url: get.url })).toBeUndefined();
    expect(host.restContractFor('no-such-request', { method: 'GET', url: '/' })).toBeUndefined();
  });

  it('a broken cache rejects, is not remembered, and the memo is dropped on close', async () => {
    const { api, apiId } = await importPets(true);
    const get = requestNamed(api, 'GET');
    const definition = join(dir, 'project', 'apis', api.slug, 'definition');
    const files = await readdir(definition);
    const root =
      files.find((file) => file !== 'manifest.yaml' && (file.endsWith('.yaml') || file.endsWith('.json'))) ?? '';
    await writeFile(join(definition, root), 'tampered: [');
    await expect(host.restContractFor(get.id, { method: 'GET', url: get.url })).rejects.toThrow();
    await writeFile(join(definition, root), DOCUMENT);
    const first = host.openApiDocumentFor(apiId);
    await expect(first).resolves.toBeDefined();
    await host.close();
    await host.openProject(join(dir, 'project'));
    expect(host.openApiDocumentFor(apiId)).not.toBe(first);
  });

  it('rematches a linked request whose method was changed since import', async () => {
    const { api } = await importPets(true);
    const get = requestNamed(api, 'GET');
    expect(get.contract).toEqual({ method: 'get', path: '/pets/{id}' });
    const target = await host.restContractFor(get.id, { method: 'POST', url: 'https://pets.example.test/v1/pets' });
    expect(target?.operation).toEqual({ method: 'post', path: '/pets' });
  });

  it('rematches a linked request pointed at another path, and has nothing when that path is undeclared', async () => {
    const { api } = await importPets(true);
    const post = requestNamed(api, 'POST');
    expect(post.contract).toEqual({ method: 'post', path: '/pets' });
    const moved = await host.restContractFor(post.id, { method: 'POST', url: 'https://pets.example.test/v1/pets/3' });
    expect(moved).toEqual({});
    const get = requestNamed(api, 'GET');
    const same = await host.restContractFor(get.id, { method: 'get', url: 'https://pets.example.test/v1/pets/9' });
    expect(same?.operation).toEqual({ method: 'get', path: '/pets/{id}' });
  });
});
