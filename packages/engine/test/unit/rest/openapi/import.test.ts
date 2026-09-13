/**
 * Reading a document from where the user pointed at: the step that fetches, resolves and parses in
 * one go, and hands back every file it was made of for the definition cache.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseOpenApi } from '../../../../src/rest/openapi/import.js';
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

  it('refuses Swagger 2.0 and a document that is not OpenAPI', async () => {
    const fetch = ((location: string) =>
      Promise.resolve({
        location,
        bytes: new Uint8Array(),
        text: location.endsWith('swagger.json') ? '{"swagger":"2.0"}' : 'name: not-openapi\n',
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
