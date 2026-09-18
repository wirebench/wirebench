/**
 * The REST model's factories and tree helpers. What matters here is what a freshly created entity
 * looks like — a request inherits its credentials rather than defaulting to none, an API starts
 * with no auth at all — and that walking a tree visits every node exactly once.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMON_METHODS,
  RAW_LANGUAGE_CONTENT_TYPES,
  RAW_LANGUAGE_EXTENSIONS,
  apiFolders,
  apiRequests,
  createApi,
  createFolder,
  createRestRequest,
  entry,
  folderRequests,
} from '../../../src/rest/model.js';

describe('createRestRequest', () => {
  it('is a GET with no body whose credentials are inherited', () => {
    const request = createRestRequest('List pets', { id: 'R1' });

    expect(request).toEqual({
      kind: 'rest',
      id: 'R1',
      name: 'List pets',
      slug: 'List pets',
      order: 0,
      method: 'GET',
      url: '',
      pathParams: [],
      query: [],
      headers: [],
      body: { kind: 'none' },
      auth: { type: 'inherit' },
      settings: {},
      assertions: [],
    });
  });

  it('slugifies a name that is illegal as a file name', () => {
    expect(createRestRequest('GET /pets/{id}?x=1', { id: 'R' }).slug).toBe('GET _pets_{id}_x=1');
  });

  it('keeps a custom method and an injected id', () => {
    let n = 0;
    const request = createRestRequest('Purge', { method: 'PURGE', newId: () => `id-${String((n += 1))}` });
    expect(request.method).toBe('PURGE');
    expect(request.id).toBe('id-1');
  });
});

describe('createApi and createFolder', () => {
  it('creates an empty API with no credentials of its own', () => {
    expect(createApi('Petstore', { id: 'A1', baseUrl: 'https://x.test' })).toEqual({
      kind: 'rest',
      id: 'A1',
      name: 'Petstore',
      slug: 'Petstore',
      order: 0,
      baseUrl: 'https://x.test',
      servers: [],
      folders: [],
      requests: [],
    });
  });

  it('creates an empty folder', () => {
    expect(createFolder('Admin', { id: 'F1', order: 2 })).toEqual({
      id: 'F1',
      name: 'Admin',
      slug: 'Admin',
      order: 2,
      folders: [],
      requests: [],
    });
  });
});

describe('entry', () => {
  it('defaults to enabled and omits an absent description', () => {
    expect(entry('page', '1')).toEqual({ name: 'page', value: '1', enabled: true });
    expect(entry('page', '1', { enabled: false, description: 'which page' })).toEqual({
      name: 'page',
      value: '1',
      enabled: false,
      description: 'which page',
    });
  });
});

describe('tree helpers', () => {
  const api = createApi('Petstore', {
    id: 'A',
    requests: [createRestRequest('Root', { id: 'r0' })],
    folders: [
      createFolder('Pets', {
        id: 'f1',
        requests: [createRestRequest('List', { id: 'r1' })],
        folders: [createFolder('Admin', { id: 'f2', requests: [createRestRequest('Delete', { id: 'r2' })] })],
      }),
      createFolder('Store', { id: 'f3', requests: [createRestRequest('Order', { id: 'r3' })] }),
    ],
  });

  it('lists every request, root first then each folder depth-first', () => {
    expect(apiRequests(api).map((request) => request.id)).toEqual(['r0', 'r1', 'r2', 'r3']);
  });

  it('lists every folder depth-first', () => {
    expect(apiFolders(api).map((folder) => folder.id)).toEqual(['f1', 'f2', 'f3']);
  });

  it('lists one folder subtree', () => {
    expect(folderRequests(api.folders[0]!).map((request) => request.id)).toEqual(['r1', 'r2']);
  });
});

describe('language tables', () => {
  it('gives every raw language a content type and an extension', () => {
    expect(Object.keys(RAW_LANGUAGE_CONTENT_TYPES).sort()).toEqual(Object.keys(RAW_LANGUAGE_EXTENSIONS).sort());
    expect(RAW_LANGUAGE_CONTENT_TYPES.json).toBe('application/json');
    expect(RAW_LANGUAGE_EXTENSIONS.javascript).toBe('js');
  });

  it('offers the seven common methods in editor order', () => {
    expect(COMMON_METHODS).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  });
});
