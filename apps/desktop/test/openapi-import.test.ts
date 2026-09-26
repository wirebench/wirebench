// @vitest-environment node
/**
 * `OpenApiImportService` builds one fetcher per read: a definition's auth is resolved from the
 * keychain first, so a dangling reference fails before any network, and only a `url` source's own
 * origin is given the credentials. The host's network options reach every fetcher.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DocumentFetchOptions, FetchDocument } from '@wirebench/engine';
import { OpenApiImportService } from '../src/main/openapi-import.js';

const OPENAPI = `openapi: 3.0.3
info:
  title: Pets
  version: '1'
paths: {}
`;

const ASYNCAPI = `asyncapi: 3.0.0
info:
  title: Chat
  version: '1'
`;

/** A service whose fetchers serve `text` for any location, recording the options each was built with. */
function service(text: string, secrets: Record<string, string> = {}) {
  const built: DocumentFetchOptions[] = [];
  const fetched: string[] = [];
  const network = vi.fn(() => Promise.resolve({}));
  const imports = new OpenApiImportService({
    getSecret: (ref) => Promise.resolve(secrets[ref]),
    network,
    createFetchDocument: (options) => {
      built.push(options);
      const fetchDocument: FetchDocument = (location) => {
        fetched.push(location);
        return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
      };
      return fetchDocument;
    },
  });
  return { imports, built, fetched, network };
}

describe('OpenApiImportService', () => {
  it("resolves the auth and scopes it to the source URL's origin", async () => {
    const { imports, built } = service(OPENAPI, { 'ref-p': 's3cret' });

    await imports.readOpenApi(
      { kind: 'url', url: 'https://gateway.test:8443/billing/openapi.yaml' },
      { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
    );

    expect(built).toHaveLength(1);
    expect(built[0]?.auth).toEqual({ type: 'basic', username: 'ada', password: 's3cret', preemptive: true });
    expect(built[0]?.authOrigin).toBe('https://gateway.test:8443');
  });

  it("passes the host's network options to every fetcher", async () => {
    const { imports, built, network } = service(OPENAPI);

    await imports.readOpenApi({ kind: 'url', url: 'https://api.test/openapi.yaml' });

    expect(built[0]?.network).toBe(network);
    expect(built[0]?.auth).toBeUndefined();
  });

  it('fails as secret-missing before fetching anything when a reference has no value', async () => {
    const { imports, fetched } = service(OPENAPI);

    const error = await imports
      .run({
        source: { kind: 'url', url: 'https://api.test/openapi.yaml' },
        auth: { type: 'bearer', tokenRef: 'gone' },
      })
      .catch((e: unknown) => e);

    expect((error as { code?: string }).code).toBe('secret-missing');
    expect(fetched).toEqual([]);
  });

  it('never gives a file or pasted text any credentials', async () => {
    const { imports, built } = service(OPENAPI, { 'ref-t': 'tok' });

    await imports.readOpenApi({ kind: 'text', text: OPENAPI }, { type: 'bearer', tokenRef: 'ref-t' });

    expect(built[0]?.auth).toBeUndefined();
    expect(built[0]?.authOrigin).toBeUndefined();
  });

  it('never gives a file source any credentials', async () => {
    const { imports, built } = service(OPENAPI, { 'ref-p': 's3cret' });

    await imports.readOpenApi(
      { kind: 'file', path: 'file:///tmp/openapi.yaml' },
      { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
    );

    expect(built).toHaveLength(1);
    expect(built[0]?.auth).toBeUndefined();
    expect(built[0]?.authOrigin).toBeUndefined();
  });

  it('builds a fetcher per read, each with only its own credentials', async () => {
    const { imports, built } = service(OPENAPI, { 'ref-a': 'first', 'ref-b': 'second' });

    await imports.readOpenApi(
      { kind: 'url', url: 'https://one.test/openapi.yaml' },
      { type: 'bearer', tokenRef: 'ref-a' },
    );
    await imports.readOpenApi({ kind: 'url', url: 'https://two.test/openapi.yaml' });
    await imports.readOpenApi(
      { kind: 'url', url: 'https://three.test/openapi.yaml' },
      { type: 'bearer', tokenRef: 'ref-b' },
    );

    expect(built).toHaveLength(3);
    expect(built[0]).toMatchObject({ auth: { type: 'bearer', token: 'first' }, authOrigin: 'https://one.test' });
    // The read in between had none: nothing from the first carried over.
    expect(built[1]?.auth).toBeUndefined();
    expect(built[1]?.authOrigin).toBeUndefined();
    expect(built[2]).toMatchObject({ auth: { type: 'bearer', token: 'second' }, authOrigin: 'https://three.test' });
  });

  it('reads a malformed URL with no credentials instead of throwing', async () => {
    const { imports, built, fetched } = service(OPENAPI, { 'ref-p': 's3cret' });

    await imports.readOpenApi(
      { kind: 'url', url: 'not a url' },
      { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
    );

    expect(built[0]?.auth).toBeUndefined();
    expect(built[0]?.authOrigin).toBeUndefined();
    expect(fetched).toEqual(['not a url']);
  });

  it('never gives a file: URL typed into the URL field any credentials', async () => {
    const { imports, built } = service(OPENAPI, { 'ref-p': 's3cret' });

    await imports.readOpenApi(
      { kind: 'url', url: 'file:///etc/passwd' },
      { type: 'basic', username: 'ada', passwordRef: 'ref-p' },
    );

    expect(built[0]?.auth).toBeUndefined();
    expect(built[0]?.authOrigin).toBeUndefined();
  });

  it('reads an AsyncAPI document with the same credentials', async () => {
    const { imports, built } = service(ASYNCAPI, { 'ref-v': 'good-key' });

    await imports.readAsyncApi(
      { kind: 'url', url: 'https://gateway.test/asyncapi.yaml' },
      { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'ref-v' },
    );

    expect(built[0]?.auth).toEqual({ type: 'api-key', name: 'api_key', value: 'good-key', in: 'query' });
    expect(built[0]?.authOrigin).toBe('https://gateway.test');
  });
});
