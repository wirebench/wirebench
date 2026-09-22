/**
 * The REST mutations: what each `ProjectChange` does to the model, and the rules that keep the file
 * layout sound — unique slugs inside a container, a rename that moves files, and a move that cannot
 * detach a subtree or cross to another API.
 */
import { describe, expect, it } from 'vitest';
import { ProjectError, createApi, createFolder, createProject, createRestRequest } from '@wirebench/engine';
import type { Project, RestApi } from '@wirebench/engine';
import {
  addApi,
  addFolder,
  addRestRequest,
  authChainFor,
  cloneRestRequest,
  findRestFolder,
  findRestRequest,
  moveNode,
  removeApi,
  removeFolder,
  removeRestRequest,
  updateApi,
  updateFolder,
  updateRestRequest,
} from '../src/main/project-rest-mutations.js';
import { restRequestPatchSchema } from '../src/shared/wire-types.js';

/** A project with one API: a root request, a `Pets` folder with two, and `Pets/Admin` with one. */
function seeded(): Project {
  const api: RestApi = createApi('Petstore', {
    id: 'api-1',
    baseUrl: 'https://petstore.test',
    auth: { type: 'api-key', name: 'api_key', in: 'header', valueRef: 'sec_k' },
    requests: [createRestRequest('Health', { id: 'req-root', order: 0 })],
    folders: [
      createFolder('Pets', {
        id: 'f-pets',
        order: 0,
        requests: [
          createRestRequest('List pets', { id: 'req-list', order: 0 }),
          createRestRequest('Create pet', { id: 'req-create', order: 1 }),
        ],
        folders: [
          createFolder('Admin', {
            id: 'f-admin',
            order: 0,
            auth: { type: 'basic', username: 'root', passwordRef: 'sec_a' },
            requests: [createRestRequest('Delete pet', { id: 'req-delete', order: 0 })],
          }),
        ],
      }),
    ],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

const api = (project: Project): RestApi => project.apis[0]!;

describe('add-api', () => {
  it('adds an API ordered after every interface and API already there', () => {
    const { project, createdId } = addApi(seeded(), { name: 'Orders', baseUrl: 'https://orders.test' });

    expect(project.apis).toHaveLength(2);
    const added = project.apis.find((entry) => entry.id === createdId)!;
    expect(added).toMatchObject({ name: 'Orders', slug: 'Orders', order: 1, baseUrl: 'https://orders.test' });
    expect(added.auth).toBeUndefined();
  });

  it('never gives an API a slug an interface or another API already uses', () => {
    const first = addApi(seeded(), { name: 'Petstore', baseUrl: 'x' });
    expect(first.project.apis.at(-1)!.slug).toBe('Petstore-2');
  });
});

describe('update-api', () => {
  it('patches the fields it names and leaves the rest alone', () => {
    const { project } = updateApi(seeded(), 'api-1', { baseUrl: 'https://other.test', description: 'notes' });

    expect(api(project)).toMatchObject({ name: 'Petstore', baseUrl: 'https://other.test', description: 'notes' });
    expect(api(project).auth).toEqual({ type: 'api-key', name: 'api_key', in: 'header', valueRef: 'sec_k' });
  });

  it('moves the folder when the name changes', () => {
    const { project } = updateApi(seeded(), 'api-1', { name: 'Pet store' });
    expect(api(project)).toMatchObject({ name: 'Pet store', slug: 'Pet store' });
  });

  it('clears an optional field on null and keeps the tree', () => {
    const { project } = updateApi(seeded(), 'api-1', { auth: null });
    expect(api(project).auth).toBeUndefined();
    expect(api(project).folders).toHaveLength(1);
  });

  it('refuses an unknown API by id', () => {
    expect(() => updateApi(seeded(), 'nope', { name: 'x' })).toThrow(ProjectError);
  });
});

describe('folders', () => {
  it('adds one at the API root and one inside a folder', () => {
    const root = addFolder(seeded(), { apiId: 'api-1', name: 'Store' });
    expect(api(root.project).folders.map((folder) => folder.name)).toEqual(['Pets', 'Store']);

    const nested = addFolder(root.project, { apiId: 'api-1', parentId: 'f-pets', name: 'Photos' });
    expect(findRestFolder(nested.project, nested.createdId!)).toMatchObject({ name: 'Photos', order: 1 });
  });

  it('gives a second folder of the same name a distinct slug', () => {
    const { project } = addFolder(seeded(), { apiId: 'api-1', name: 'Pets' });
    expect(api(project).folders.map((folder) => folder.slug)).toEqual(['Pets', 'Pets-2']);
  });

  it('renames a folder deep in the tree', () => {
    const { project } = updateFolder(seeded(), 'f-admin', { name: 'Back office' });
    expect(findRestFolder(project, 'f-admin')).toMatchObject({ name: 'Back office', slug: 'Back office' });
  });

  it('removes a folder and everything under it', () => {
    const { project } = removeFolder(seeded(), 'f-pets');

    expect(api(project).folders).toEqual([]);
    expect(findRestRequest(project, 'req-delete')).toBeUndefined();
    expect(findRestRequest(project, 'req-root')).toBeDefined();
  });

  it('refuses an unknown folder', () => {
    expect(() => removeFolder(seeded(), 'nope')).toThrow(/No folder with id nope/);
  });
});

describe('requests', () => {
  it('adds one named after the next free Request N', () => {
    const first = addRestRequest(seeded(), { apiId: 'api-1' });
    expect(findRestRequest(first.project, first.createdId!)).toMatchObject({
      name: 'Request 1',
      method: 'GET',
      auth: { type: 'inherit' },
    });

    const second = addRestRequest(first.project, { apiId: 'api-1' });
    expect(findRestRequest(second.project, second.createdId!)).toMatchObject({ name: 'Request 2' });
  });

  it('adds one to a folder with the name it was given', () => {
    const { project, createdId } = addRestRequest(seeded(), { apiId: 'api-1', parentId: 'f-admin', name: 'Purge' });
    expect(findRestRequest(project, createdId!)).toMatchObject({ name: 'Purge', order: 1 });
  });

  it('patches only the fields the patch names', () => {
    const { project } = updateRestRequest(seeded(), 'req-list', {
      method: 'POST',
      url: '/pets/{id}',
      query: [{ name: 'page', value: '1', enabled: true }],
    });

    expect(findRestRequest(project, 'req-list')).toMatchObject({
      name: 'List pets',
      method: 'POST',
      url: '/pets/{id}',
      query: [{ name: 'page', value: '1', enabled: true }],
      headers: [],
    });
  });

  it('keeps the contract link through an edit, and a patch cannot set or forge one', () => {
    const base = seeded();
    const linked: Project = {
      ...base,
      apis: base.apis.map((api) => ({
        ...api,
        folders: api.folders.map((folder) => ({
          ...folder,
          requests: folder.requests.map((request) =>
            request.id === 'req-list' ? { ...request, contract: { method: 'get', path: '/pets' } } : request,
          ),
        })),
      })),
    };
    const forged = restRequestPatchSchema.parse({ url: '/pets?x=1', contract: { method: 'delete', path: '/x' } });
    const { project } = updateRestRequest(linked, 'req-list', forged);
    expect(findRestRequest(project, 'req-list')!.contract).toEqual({ method: 'get', path: '/pets' });
    const clone = cloneRestRequest(linked, 'req-list');
    expect(findRestRequest(clone.project, clone.createdId!)!.contract).toEqual({ method: 'get', path: '/pets' });

    const unlinked = updateRestRequest(
      base,
      'req-create',
      restRequestPatchSchema.parse({ contract: { method: 'get', path: '/x' } }),
    );
    expect(findRestRequest(unlinked.project, 'req-create')).not.toHaveProperty('contract');
  });

  it('replaces settings wholesale, so an override can be turned back off', () => {
    const once = updateRestRequest(seeded(), 'req-list', { settings: { timeoutMs: 1_000, followRedirects: false } });
    expect(findRestRequest(once.project, 'req-list')!.settings).toEqual({ timeoutMs: 1_000, followRedirects: false });

    const again = updateRestRequest(once.project, 'req-list', { settings: { timeoutMs: 1_000 } });
    expect(again.project && findRestRequest(again.project, 'req-list')!.settings).toEqual({ timeoutMs: 1_000 });
  });

  it('renames a request and gives it a unique slug in its own folder', () => {
    const { project } = updateRestRequest(seeded(), 'req-create', { name: 'List pets' });
    expect(findRestRequest(project, 'req-create')).toMatchObject({ name: 'List pets', slug: 'List pets-2' });
  });

  it('clones a request beside the original', () => {
    const { project, createdId } = cloneRestRequest(seeded(), 'req-list');

    const folder = findRestFolder(project, 'f-pets')!;
    expect(folder.requests.map((request) => request.name)).toEqual(['List pets', 'List pets copy', 'Create pet']);
    expect(findRestRequest(project, createdId!)).toMatchObject({ slug: 'List pets copy', order: 1 });
  });

  it('removes a request and renumbers its siblings', () => {
    const { project } = removeRestRequest(seeded(), 'req-list');

    const folder = findRestFolder(project, 'f-pets')!;
    expect(folder.requests.map((request) => request.id)).toEqual(['req-create']);
    expect(folder.requests[0]!.order).toBe(0);
  });
});

describe('move-node', () => {
  it('moves a request into another folder at an index', () => {
    const { project } = moveNode(seeded(), { nodeId: 'req-root', parentId: 'f-pets', index: 1 });

    expect(api(project).requests).toEqual([]);
    expect(findRestFolder(project, 'f-pets')!.requests.map((request) => request.id)).toEqual([
      'req-list',
      'req-root',
      'req-create',
    ]);
  });

  it('moves a request to the API root when no parent is given', () => {
    const { project } = moveNode(seeded(), { nodeId: 'req-delete', index: 0 });
    expect(api(project).requests.map((request) => request.id)).toEqual(['req-delete', 'req-root']);
  });

  it('moves a folder, subtree and all', () => {
    const { project } = moveNode(seeded(), { nodeId: 'f-admin', index: 1 });

    expect(api(project).folders.map((folder) => folder.id)).toEqual(['f-pets', 'f-admin']);
    expect(findRestFolder(project, 'f-pets')!.folders).toEqual([]);
    expect(findRestRequest(project, 'req-delete')).toBeDefined();
  });

  it('clamps a stale index rather than throwing', () => {
    const { project } = moveNode(seeded(), { nodeId: 'req-root', parentId: 'f-admin', index: 99 });
    expect(findRestFolder(project, 'f-admin')!.requests.map((request) => request.id)).toEqual([
      'req-delete',
      'req-root',
    ]);
  });

  it('refuses to move a folder into itself or its own descendant', () => {
    expect(() => moveNode(seeded(), { nodeId: 'f-pets', parentId: 'f-pets', index: 0 })).toThrow(/into itself/);
    expect(() => moveNode(seeded(), { nodeId: 'f-pets', parentId: 'f-admin', index: 0 })).toThrow(/inside itself/);
  });

  it('refuses to move across APIs, which would separate a request from its definition', () => {
    const two = addApi(seeded(), { name: 'Orders', baseUrl: 'x' });
    expect(() => moveNode(two.project, { nodeId: 'req-root', apiId: two.createdId!, index: 0 })).toThrow(/another API/);
  });

  it('gives a moved node a unique slug in its new home', () => {
    const withClash = addRestRequest(seeded(), { apiId: 'api-1', parentId: 'f-admin', name: 'Health' });
    const { project } = moveNode(withClash.project, { nodeId: 'req-root', parentId: 'f-admin', index: 0 });

    const slugs = findRestFolder(project, 'f-admin')!.requests.map((request) => request.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('Health-2');
  });
});

describe('remove-api', () => {
  it('removes the API and renumbers the rest', () => {
    const two = addApi(seeded(), { name: 'Orders', baseUrl: 'x' });
    const { project } = removeApi(two.project, 'api-1');

    expect(project.apis.map((entry) => entry.name)).toEqual(['Orders']);
    expect(project.apis[0]!.order).toBe(0);
  });
});

describe('authChainFor', () => {
  it('is the request, then each folder outwards, then the API', () => {
    expect(authChainFor(seeded(), 'req-delete')).toEqual([
      { type: 'inherit' },
      { type: 'basic', username: 'root', passwordRef: 'sec_a' },
      undefined,
      { type: 'api-key', name: 'api_key', in: 'header', valueRef: 'sec_k' },
    ]);
  });

  it('is the request then the API for one at the root', () => {
    expect(authChainFor(seeded(), 'req-root')).toEqual([
      { type: 'inherit' },
      { type: 'api-key', name: 'api_key', in: 'header', valueRef: 'sec_k' },
    ]);
  });

  it('is undefined for a request that is not in any API', () => {
    expect(authChainFor(seeded(), 'nope')).toBeUndefined();
  });
});
