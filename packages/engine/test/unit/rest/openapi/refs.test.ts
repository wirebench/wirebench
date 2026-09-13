/**
 * Following `$ref`.
 *
 * Three things have to hold, and each is a security or robustness property rather than a nicety: a
 * reference that leads nowhere is reported and the document still imports; a cyclic document
 * terminates; and the reference policy — the same one WSDL import uses — keeps a remote document from
 * reading local files.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { resolvePointer, resolveRefs, unescapePointerToken } from '../../../../src/rest/openapi/refs.js';
import type { FetchDocument } from '../../../../src/wsdl/resolver.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));

/** A fetcher serving a fixed map of location to text, recording what it was asked for. */
function fetcherFor(documents: Readonly<Record<string, string>>): FetchDocument & { readonly asked: string[] } {
  const asked: string[] = [];
  const fetch = ((location: string) => {
    asked.push(location);
    const text = documents[location];
    if (text === undefined) {
      return Promise.reject(new Error(`no document at ${location}`));
    }
    return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
  }) as FetchDocument & { asked: string[] };
  fetch.asked = asked;
  return fetch;
}

/** The real files of one crafted fixture, keyed by `file:` URL. */
function craftedFiles(name: string, files: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [
      pathToFileURL(`${craftedDir}${name}/${file}`).href,
      readFileSync(`${craftedDir}${name}/${file}`, 'utf-8'),
    ]),
  );
}

describe('unescapePointerToken', () => {
  it('unescapes RFC 6901 in the order the specification fixes', () => {
    expect(unescapePointerToken('a~1b')).toBe('a/b');
    expect(unescapePointerToken('a~0b')).toBe('a~b');
    // `~01` is a literal `~1`, which only holds when `~1` is replaced before `~0`.
    expect(unescapePointerToken('a~01b')).toBe('a~1b');
  });
});

describe('resolvePointer', () => {
  const document = { a: { 'b/c': 1, list: [{ x: 2 }] }, 'm~n': 3 };

  it('reads the whole document for an empty pointer', () => {
    expect(resolvePointer(document, '')).toBe(document);
    expect(resolvePointer(document, '#')).toBe(document);
  });

  it('walks objects, arrays and escaped tokens', () => {
    expect(resolvePointer(document, '#/a/b~1c')).toBe(1);
    expect(resolvePointer(document, '#/a/list/0/x')).toBe(2);
    expect(resolvePointer(document, '#/m~0n')).toBe(3);
  });

  it('is undefined for a pointer that leads nowhere, rather than throwing', () => {
    expect(resolvePointer(document, '#/a/missing')).toBeUndefined();
    expect(resolvePointer(document, '#/a/list/9')).toBeUndefined();
    expect(resolvePointer(document, '#/a/b~1c/deeper')).toBeUndefined();
    expect(resolvePointer(document, 'not-a-pointer')).toBeUndefined();
  });
});

describe('resolveRefs', () => {
  it('inlines a local reference', async () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      paths: { '/a': { get: { parameters: [{ $ref: '#/components/parameters/P' }] } } },
      components: { parameters: { P: { name: 'p', in: 'query' } } },
    });
    const resolved = await resolveRefs(text, 'inline:openapi', { fetchDocument: fetcherFor({}) });

    const document = resolved.document as { paths: { '/a': { get: { parameters: unknown[] } } } };
    expect(document.paths['/a'].get.parameters[0]).toEqual({ name: 'p', in: 'query' });
    expect(resolved.problems).toEqual([]);
    expect(resolved.documents).toHaveLength(1);
  });

  it("follows a relative reference into another file, and that file's own local one", async () => {
    const root = pathToFileURL(`${craftedDir}refs/openapi.yaml`).href;
    const files = craftedFiles('refs', ['openapi.yaml', 'shared/parameters.yaml', 'shared/schemas.yaml']);
    const fetch = fetcherFor(files);

    const resolved = await resolveRefs(files[root]!, root, { fetchDocument: fetch });

    const document = resolved.document as {
      paths: Record<string, { post?: { parameters: { name: string }[]; requestBody: unknown } }>;
    };
    const parameters = document.paths['/pets']?.post?.parameters ?? [];
    expect(parameters.map((parameter) => parameter.name)).toEqual(['X-Trace', 'pageSize']);
    // `Pet.status` is a local `$ref` *inside the referenced file*, so it is resolved against that
    // file rather than against the root.
    expect(document.paths['/pets']?.post?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { properties: { status: { enum: ['available', 'sold'] } } },
        },
      },
    });
    // Root plus the two shared files, each fetched once.
    expect(resolved.documents).toHaveLength(3);
    expect(fetch.asked).toHaveLength(2);
  });

  it('reports a reference that leads nowhere, and leaves the $ref in place', async () => {
    const root = pathToFileURL(`${craftedDir}refs/openapi.yaml`).href;
    const files = craftedFiles('refs', ['openapi.yaml', 'shared/parameters.yaml', 'shared/schemas.yaml']);

    const resolved = await resolveRefs(files[root]!, root, { fetchDocument: fetcherFor(files) });

    expect(resolved.problems).toEqual([
      expect.objectContaining({ ref: '#/components/parameters/DoesNotExist', reason: 'nothing at that location' }),
    ]);
    const document = resolved.document as { paths: Record<string, { get?: { parameters: unknown[] } }> };
    expect(document.paths['/broken']?.get?.parameters[0]).toEqual({ $ref: '#/components/parameters/DoesNotExist' });
  });

  it('terminates on a cyclic schema, cutting the branch at the repeat', async () => {
    const root = pathToFileURL(`${craftedDir}cycle/openapi.yaml`).href;
    const text = readFileSync(`${craftedDir}cycle/openapi.yaml`, 'utf-8');

    const resolved = await resolveRefs(text, root, { fetchDocument: fetcherFor({}) });

    const schema = (
      resolved.document as {
        paths: {
          '/nodes': { post: { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } } };
        };
      }
    ).paths['/nodes'].post.requestBody.content['application/json']!.schema;
    // The body's own schema was inlined; the reference back to itself stayed a `$ref`, which is the
    // cut — and it is the same shape the sample generator's depth cap already handles.
    expect(schema['type']).toBe('object');
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['child']).toEqual({ $ref: '#/components/schemas/Node' });
    expect((properties['peers']?.['items'] as Record<string, unknown>) ?? {}).toEqual({
      $ref: '#/components/schemas/Node',
    });
    // A cycle is normal in a description, so it is not a problem to report.
    expect(resolved.problems).toEqual([]);
  });

  it('refuses a local file reference out of a remote document, and says why', async () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      paths: { '/a': { get: { parameters: [{ $ref: 'file:///etc/passwd#/x' }] } } },
    });
    const fetch = fetcherFor({});

    const resolved = await resolveRefs(text, 'https://remote.test/openapi.json', { fetchDocument: fetch });

    expect(resolved.problems[0]).toMatchObject({ reason: 'a remote definition may not reference local files' });
    // And nothing was even asked for.
    expect(fetch.asked).toEqual([]);
  });

  it("refuses a file reference outside the root document's own folder", async () => {
    const root = pathToFileURL(`${craftedDir}refs/openapi.yaml`).href;
    const text = JSON.stringify({
      openapi: '3.0.3',
      paths: { '/a': { get: { parameters: [{ $ref: '../../../package.json#/name' }] } } },
    });

    const resolved = await resolveRefs(text, root, { fetchDocument: fetcherFor({}) });

    expect(resolved.problems[0]?.reason).toMatch(/outside the definition's folder/);
  });

  it('reports a referenced document that cannot be fetched, and carries on', async () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      paths: { '/a': { get: { parameters: [{ $ref: 'missing.yaml#/components/parameters/P' }] } } },
    });

    const resolved = await resolveRefs(text, 'https://remote.test/openapi.json', { fetchDocument: fetcherFor({}) });

    expect(resolved.problems[0]?.reason).toMatch(/could not be fetched/);
  });

  it('reports a referenced document that is not parseable', async () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      paths: { '/a': { get: { parameters: [{ $ref: 'broken.json#/x' }] } } },
    });
    const fetch = fetcherFor({ 'https://remote.test/broken.json': '{"a":' });

    const resolved = await resolveRefs(text, 'https://remote.test/openapi.json', { fetchDocument: fetch });

    expect(resolved.problems[0]?.reason).toMatch(/not valid JSON/);
  });

  it('resolves a sibling reference against where a redirect actually landed', async () => {
    const text = JSON.stringify({
      openapi: '3.0.3',
      paths: { '/a': { get: { parameters: [{ $ref: 'shared.json#/p' }] } } },
    });
    // The fetcher answers the redirected location, as the real one does.
    const fetch = ((location: string) =>
      Promise.resolve({
        location,
        bytes: new TextEncoder().encode('{"p":{"name":"p","in":"query"}}'),
        text: '{"p":{"name":"p","in":"query"}}',
      })) as FetchDocument;

    const resolved = await resolveRefs(text, 'https://cdn.test/v2/openapi.json', { fetchDocument: fetch });

    const document = resolved.document as { paths: { '/a': { get: { parameters: unknown[] } } } };
    expect(document.paths['/a'].get.parameters[0]).toEqual({ name: 'p', in: 'query' });
    expect(resolved.documents[1]?.location).toBe('https://cdn.test/v2/shared.json');
  });

  it('stops when the signal fires, rather than fetching the rest', async () => {
    const controller = new AbortController();
    const text = JSON.stringify({
      openapi: '3.0.3',
      paths: { '/a': { get: { parameters: [{ $ref: 'one.json#/p' }] } } },
    });
    const fetch = vi.fn(() => {
      controller.abort();
      return Promise.resolve({ location: 'x', bytes: new Uint8Array(), text: '{}' });
    }) as unknown as FetchDocument;

    await expect(
      resolveRefs(text, 'https://remote.test/openapi.json', { fetchDocument: fetch, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
