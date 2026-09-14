/**
 * Reading a document from where the user pointed at: the step that fetches, resolves and parses in
 * one go, and hands back every file it was made of for the definition cache.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { importOpenApi, parseOpenApi } from '../../../../src/rest/openapi/import.js';
import type { FetchDocument } from '../../../../src/wsdl/resolver.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));

/** A fetcher reading the real crafted fixtures off disk, recording what it was asked for. */
function fileFetcher(): FetchDocument & { readonly asked: string[] } {
  const asked: string[] = [];
  const fetch = ((location: string) => {
    asked.push(location);
    const text = readFileSync(fileURLToPath(location), 'utf-8');
    return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
  }) as FetchDocument & { asked: string[] };
  fetch.asked = asked;
  return fetch;
}

describe('parseOpenApi', () => {
  it('reads a file source, following its relative references', async () => {
    const fetch = fileFetcher();
    const source = { kind: 'file' as const, path: pathToFileURL(`${craftedDir}refs/openapi.yaml`).href };

    const parsed = await parseOpenApi(source, { fetchDocument: fetch });

    expect(parsed.document.info.title).toBe('Refs');
    // Root plus the two shared files, in the order they were reached — what the cache stores.
    expect(parsed.documents).toHaveLength(3);
    expect(parsed.documents[0]?.location).toBe(source.path);
    expect(parsed.refProblems.map((problem) => problem.ref)).toEqual(['#/components/parameters/DoesNotExist']);
  });

  it("keeps each document's bytes exactly as they were read, so an export can be byte-identical", async () => {
    const path = pathToFileURL(`${craftedDir}refs/shared/schemas.yaml`).href;
    const parsed = await parseOpenApi(
      { kind: 'file', path: pathToFileURL(`${craftedDir}refs/openapi.yaml`).href },
      { fetchDocument: fileFetcher() },
    );

    const shared = parsed.documents.find((document) => document.location === path);
    expect(shared?.bytes).toEqual(new Uint8Array(readFileSync(fileURLToPath(path))));
  });

  it('reads a URL source, and resolves relative references against where it landed', async () => {
    const documents: Record<string, string> = {
      'https://api.test/openapi.json': JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Remote' },
        paths: { '/a': { get: { parameters: [{ $ref: 'params.json#/p' }] } } },
      }),
      'https://api.test/params.json': JSON.stringify({ p: { name: 'p', in: 'query' } }),
    };
    const fetch = ((location: string) =>
      Promise.resolve({
        location,
        bytes: new TextEncoder().encode(documents[location] ?? ''),
        text: documents[location] ?? '',
      })) as FetchDocument;

    const parsed = await parseOpenApi({ kind: 'url', url: 'https://api.test/openapi.json' }, { fetchDocument: fetch });

    expect(parsed.document.operations[0]?.parameters[0]?.name).toBe('p');
    expect(parsed.documents.map((document) => document.location)).toEqual([
      'https://api.test/openapi.json',
      'https://api.test/params.json',
    ]);
  });

  it('reads text the user already has, and refuses a local reference out of it', async () => {
    const fetch = fileFetcher();
    const parsed = await parseOpenApi(
      {
        kind: 'text',
        text: 'openapi: 3.0.3\ninfo:\n  title: Pasted\npaths:\n  /a:\n    get:\n      parameters:\n        - $ref: "file:///etc/passwd#/x"\n',
      },
      { fetchDocument: fetch },
    );

    expect(parsed.document.info.title).toBe('Pasted');
    expect(parsed.refProblems[0]?.reason).toMatch(/only a definition imported from a file/);
    expect(fetch.asked).toEqual([]);
  });

  it("refuses a file source that is not a file: URL, rather than guessing the platform's rules", async () => {
    await expect(
      parseOpenApi({ kind: 'file', path: '/tmp/openapi.yaml' }, { fetchDocument: fileFetcher() }),
    ).rejects.toMatchObject({ code: 'openapi-source-invalid' });
  });

  it('refuses unsupported Swagger versions and a document that is not OpenAPI', async () => {
    const fetch = ((location: string) =>
      Promise.resolve({
        location,
        bytes: new Uint8Array(),
        text: location.endsWith('swagger.json') ? '{"swagger":"1.2"}' : 'name: not-openapi\n',
      })) as FetchDocument;

    await expect(
      parseOpenApi({ kind: 'url', url: 'https://api.test/swagger.json' }, { fetchDocument: fetch }),
    ).rejects.toMatchObject({ code: 'openapi-unsupported-version' });
    await expect(
      parseOpenApi({ kind: 'url', url: 'https://api.test/other.yaml' }, { fetchDocument: fetch }),
    ).rejects.toMatchObject({ code: 'openapi-not-a-document' });
  });

  it('passes the signal through, so a cancel stops the fetch', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_location: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return Promise.resolve({ location: 'x', bytes: new Uint8Array(), text: '{}' });
    }) as unknown as FetchDocument;
    controller.abort();

    await expect(
      parseOpenApi(
        { kind: 'url', url: 'https://api.test/openapi.json' },
        { fetchDocument: fetch, signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
});

describe('importOpenApi', () => {
  it('hands back the API, every document it was made of, and what it could not use', async () => {
    const fetch = fileFetcher();

    const imported = await importOpenApi(
      { kind: 'file', path: pathToFileURL(`${craftedDir}refs/openapi.yaml`).href },
      { fetchDocument: fetch, name: 'Refs API' },
    );

    expect(imported.api.name).toBe('Refs API');
    expect(imported.documents).toHaveLength(3);
    // A reference that could not be followed is reported, never fatal: the import is the API the
    // document does describe.
    expect(imported.summary.skipped).toContainEqual({
      kind: 'reference',
      where: '/paths/~1broken/get/parameters/0',
      reason: '#/components/parameters/DoesNotExist: nothing at that location',
    });
    expect(imported.summary.requests).toBe(2);
  });

  it('maps a referenced body and parameter as if they had been written inline', async () => {
    const imported = await importOpenApi(
      { kind: 'file', path: pathToFileURL(`${craftedDir}refs/openapi.yaml`).href },
      { fetchDocument: fileFetcher() },
    );

    const request = imported.api.folders
      .flatMap((folder) => folder.requests)
      .find((candidate) => candidate.name === 'createPet');
    expect(request?.headers).toEqual([{ name: 'X-Trace', value: 'local-ref', enabled: false }]);
    expect(request?.query.map((row) => row.name)).toEqual(['pageSize']);
    expect(request?.body.kind).toBe('raw');
  });

  it('imports an OpenAPI 3.2 document with additionalOperations and streaming media types', async () => {
    const imported = await importOpenApi(
      { kind: 'file', path: pathToFileURL(`${craftedDir}v32/openapi.yaml`).href },
      { fetchDocument: fileFetcher() },
    );

    expect(imported.document.version).toBe('3.2');
    expect(imported.summary.declaredVersion).toBe('3.2.0');
    expect(imported.api.name).toBe('OAS 3.2 Features');

    const searchFolder = imported.api.folders.find((folder) => folder.name === 'Search');
    const queryReq = searchFolder?.requests.find((req) => req.name === 'Search pets via QUERY');
    expect(queryReq).toBeDefined();
    expect(queryReq?.method).toBe('QUERY');
    expect(queryReq?.url).toBe('/search');
    expect(queryReq?.body).toMatchObject({
      kind: 'raw',
      language: 'json',
    });
    expect((queryReq?.body as { text: string }).text).toContain('"term": "beagle"');

    const allRequests = [...imported.api.requests, ...imported.api.folders.flatMap((f) => f.requests)];
    const streamReq = allRequests.find((req) => req.name === 'Send event stream');
    expect(streamReq).toBeDefined();
    expect(streamReq?.method).toBe('POST');
    expect(streamReq?.url).toBe('/stream');
  });

  it('imports a document declaring swagger: 3.0.3', async () => {
    const swaggerDoc = `
swagger: 3.0.3
info:
  title: Swagger 3 Sample
  version: 1.0.0
servers:
  - url: https://swagger3.test
paths:
  /items:
    get:
      summary: List Items
      responses:
        '200':
          description: OK
`;
    const imported = await importOpenApi({ kind: 'text', text: swaggerDoc }, { fetchDocument: fileFetcher() });

    expect(imported.document.version).toBe('3.0');
    expect(imported.summary.declaredVersion).toBe('Swagger 3.0.3');
    expect(imported.api.name).toBe('Swagger 3 Sample');
    expect(imported.api.baseUrl).toBe('https://swagger3.test');

    const allRequests = [...imported.api.requests, ...imported.api.folders.flatMap((f) => f.requests)];
    const itemsReq = allRequests.find((req) => req.name === 'List Items');
    expect(itemsReq).toBeDefined();
    expect(itemsReq?.method).toBe('GET');
  });

  it('imports a document declaring swagger: 2.0', async () => {
    const path = pathToFileURL(`${craftedDir}v20/swagger.json`).href;
    const imported = await importOpenApi({ kind: 'file', path }, { fetchDocument: fileFetcher() });

    expect(imported.document.version).toBe('2.0');
    expect(imported.summary.declaredVersion).toBe('Swagger 2.0');
    expect(imported.api.name).toBe('Swagger Petstore');
    expect(imported.api.baseUrl).toBe('https://api.petstore.test:8443/api/v2');
    expect(imported.summary.servers).toEqual([
      { url: 'https://api.petstore.test:8443/api/v2' },
      { url: 'http://api.petstore.test:8443/api/v2' },
    ]);

    const allRequests = [...imported.api.requests, ...imported.api.folders.flatMap((f) => f.requests)];
    const listPets = allRequests.find((req) => req.name === 'List all pets');
    expect(listPets).toBeDefined();
    expect(listPets?.method).toBe('GET');
    expect(listPets?.url).toContain('/pets');

    const createPet = allRequests.find((req) => req.name === 'Create a pet');
    expect(createPet).toBeDefined();
    expect(createPet?.method).toBe('POST');
    expect(createPet?.body.kind).toBe('raw');

    const uploadPhoto = allRequests.find((req) => req.name === 'Upload photo for pet');
    expect(uploadPhoto).toBeDefined();
    expect(uploadPhoto?.method).toBe('POST');
    expect(uploadPhoto?.body.kind).toBe('multipart');

    expect(imported.summary.securitySchemes.map((s) => s.name)).toEqual(['api_key', 'basic_auth', 'petstore_auth']);
  });
});
