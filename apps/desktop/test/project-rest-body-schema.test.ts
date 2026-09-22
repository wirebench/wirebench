// @vitest-environment node
/**
 * `ProjectHost.restBodySchema`: the JSON schema of the body a REST request's operation declares,
 * found the way `restContractFor` finds the operation, and made safe to cross IPC.
 */
import { mkdtempSync } from 'node:fs';
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
  /pets:
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
      responses:
        '201': { description: created }
  /pets/{id}:
    put:
      requestBody:
        content:
          application/xml:
            schema: { type: object, properties: { name: { type: string } } }
      responses:
        '200': { description: ok }
    patch:
      requestBody:
        content:
          application/vnd.x+json:
            schema: { type: object, properties: { tag: { type: string } } }
      responses:
        '200': { description: ok }
components:
  schemas:
    Pet:
      type: object
      required: [name]
      properties:
        name: { type: string }
        parent: { $ref: '#/components/schemas/Pet' }
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

function allRequests(api: RestApi): RestRequestDef[] {
  return [...api.requests, ...api.folders.flatMap((folder) => folder.requests)];
}

function requestNamed(api: RestApi, method: string): RestRequestDef {
  const found = allRequests(api).find((request) => request.method === method);
  if (found === undefined) throw new Error(`no ${method} request`);
  return found;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-rest-body-schema-'));
  host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  await host.create({ dir: join(dir, 'project'), name: 'Pets' });
});

describe('ProjectHost.restBodySchema', () => {
  it("answers a linked request's JSON body schema, acyclic and serialisable", async () => {
    const { api } = await importPets(true);
    const post = requestNamed(api, 'POST');
    const found = await host.restBodySchema(post.id);
    expect(found?.mediaType).toBe('application/json');
    expect(found?.schema.required).toEqual(['name']);
    expect(found?.schema.properties?.['name']).toEqual({ type: 'string' });
    expect(() => JSON.stringify(found)).not.toThrow();
  });

  it('matches an unlinked request by its method and URL', async () => {
    const { api, apiId } = await importPets(true);
    const before = new Set(allRequests(api).map((r) => r.id));
    const { createdId } = await host.mutate({ kind: 'add-rest-request', apiId });
    const addedId =
      createdId ??
      allRequests(host.model()?.apis.find((candidate) => candidate.id === apiId) as RestApi).find(
        (request) => !before.has(request.id),
      )?.id ??
      '';
    await host.mutate({
      kind: 'update-rest-request',
      requestId: addedId,
      patch: { method: 'POST', url: 'https://pets.example.test/v1/pets' },
    });
    const found = await host.restBodySchema(addedId);
    expect(found?.mediaType).toBe('application/json');
    expect(found?.schema.required).toEqual(['name']);
  });

  it('has nothing for an operation whose only body is XML', async () => {
    const { api } = await importPets(true);
    expect(await host.restBodySchema(requestNamed(api, 'PUT').id)).toBeUndefined();
  });

  it('accepts a vendor +json media type', async () => {
    const { api } = await importPets(true);
    const found = await host.restBodySchema(requestNamed(api, 'PATCH').id);
    expect(found?.mediaType).toBe('application/vnd.x+json');
    expect(found?.schema.properties?.['tag']).toEqual({ type: 'string' });
  });

  it('has nothing for an API without a cached definition, or no request at all', async () => {
    const { api } = await importPets(false);
    expect(await host.restBodySchema(requestNamed(api, 'POST').id)).toBeUndefined();
    expect(await host.restBodySchema('no-such-request')).toBeUndefined();
  });
});
