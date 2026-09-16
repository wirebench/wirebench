/**
 * The `apis/` half of the project folder: what a REST API, its folders and its requests look like
 * on disk, and that loading them back produces the same model.
 *
 * The rules this file exists to pin down, beyond a plain round trip:
 * a raw body lives in its own file so it diffs as what it is; renaming a request still touches
 * exactly two files; a `kind` this build does not support is refused rather than guessed at; and
 * every recoverable oddity (a missing body, a too-deep folder, a slug an interface already uses)
 * is a problem the project still opens with.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectError } from '../../../src/errors.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import { APIS_DIR, MAX_FOLDER_DEPTH } from '../../../src/project/paths.js';
import { saveProject } from '../../../src/project/save.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { createApi, createFolder, createRestRequest, entry } from '../../../src/rest/model.js';
import type { Project } from '../../../src/project/model.js';
import type { RestApi } from '../../../src/rest/model.js';
import { listTree, tempProjectDir } from './fixture.js';

/** An API exercising every body kind, both auth positions, and two levels of folders. */
function petstore(): RestApi {
  return createApi('Petstore', {
    id: 'A1',
    order: 0,
    description: 'The example service.',
    baseUrl: 'https://petstore.test/api/v3',
    servers: [
      { url: 'https://petstore.test/api/v3', description: 'Production' },
      { url: 'https://staging.petstore.test/api/v3' },
    ],
    auth: { type: 'api-key', name: 'api_key', in: 'header', valueRef: 'sec_key' },
    definition: { source: 'https://petstore.test/openapi.json', cache: true, version: '3.0.4' },
    requests: [createRestRequest('Health', { id: 'R0', order: 0, url: '/health', settings: { timeoutMs: 5_000 } })],
    folders: [
      createFolder('Pets', {
        id: 'F1',
        order: 0,
        description: 'Everything about pets.',
        requests: [
          createRestRequest('Get pet by id', {
            id: 'R1',
            order: 0,
            url: '/pet/{petId}',
            description: 'Returns a single pet.',
            pathParams: [entry('petId', '42')],
            query: [entry('verbose', 'true', { enabled: false, description: 'more fields' })],
            headers: [entry('Accept', 'application/json')],
          }),
          createRestRequest('Create pet', {
            id: 'R2',
            order: 1,
            method: 'POST',
            url: '/pet',
            body: { kind: 'raw', language: 'json', text: '{\n  "name": "Fido"\n}\n' },
            settings: { followRedirects: false, escapeProperties: true },
          }),
          createRestRequest('Upload image', {
            id: 'R3',
            order: 2,
            method: 'POST',
            url: '/pet/{petId}/uploadImage',
            pathParams: [entry('petId', '42')],
            body: {
              kind: 'multipart',
              parts: [
                { kind: 'text', name: 'caption', value: 'a dog', enabled: true },
                {
                  kind: 'file',
                  name: 'file',
                  source: { kind: 'path', path: './dog.png' },
                  enabled: false,
                  fileName: 'dog.png',
                  contentType: 'image/png',
                },
              ],
            },
          }),
        ],
        folders: [
          createFolder('Admin', {
            id: 'F2',
            order: 0,
            auth: { type: 'basic', username: 'root', passwordRef: 'sec_admin' },
            requests: [
              createRestRequest('Delete pet', {
                id: 'R4',
                method: 'DELETE',
                url: '/pet/{petId}',
                pathParams: [entry('petId', '42')],
              }),
            ],
          }),
        ],
      }),
      createFolder('Store', {
        id: 'F3',
        order: 1,
        requests: [
          createRestRequest('Place order', {
            id: 'R5',
            method: 'POST',
            url: '/store/order',
            body: { kind: 'form', fields: [entry('petId', '42'), entry('quantity', '1', { enabled: false })] },
            auth: { type: 'bearer', tokenRef: 'sec_token', scheme: 'Bearer' },
          }),
          createRestRequest('Upload receipt', {
            id: 'R6',
            method: 'PUT',
            url: '/store/receipt',
            body: { kind: 'binary', source: { kind: 'cache', sha256: 'a'.repeat(64) }, contentType: 'application/pdf' },
          }),
        ],
      }),
    ],
  });
}

/** A project with one hand-built API and one imported one, and no SOAP interfaces. */
function apiProject(): Project {
  return {
    ...createProject('REST demo', { id: 'P1' }),
    apis: [
      petstore(),
      createApi('Orders', {
        id: 'A2',
        order: 1,
        baseUrl: '${#Env#ordersBase}',
        requests: [createRestRequest('List orders', { id: 'R7', url: '/orders' })],
      }),
    ],
  };
}

describe('the apis/ layout', () => {
  it('puts every API, folder, request and raw body where the format says', () => {
    expect([...projectFiles(apiProject()).keys()].sort()).toEqual([
      'apis/Orders/api.yaml',
      'apis/Orders/requests/List orders.request.yaml',
      'apis/Petstore/api.yaml',
      'apis/Petstore/requests/Health.request.yaml',
      'apis/Petstore/requests/Pets/Admin/Delete pet.request.yaml',
      'apis/Petstore/requests/Pets/Admin/folder.yaml',
      'apis/Petstore/requests/Pets/Create pet.body.json',
      'apis/Petstore/requests/Pets/Create pet.request.yaml',
      'apis/Petstore/requests/Pets/Get pet by id.request.yaml',
      'apis/Petstore/requests/Pets/Upload image.request.yaml',
      'apis/Petstore/requests/Pets/folder.yaml',
      'apis/Petstore/requests/Store/Place order.request.yaml',
      'apis/Petstore/requests/Store/Upload receipt.request.yaml',
      'apis/Petstore/requests/Store/folder.yaml',
      'wirebench.yaml',
    ]);
  });

  it('writes a raw body as a file of its own language, not a string in the YAML', () => {
    const files = projectFiles(apiProject());
    expect(files.get('apis/Petstore/requests/Pets/Create pet.body.json')).toBe('{\n  "name": "Fido"\n}\n');
    const document = files.get('apis/Petstore/requests/Pets/Create pet.request.yaml')!;
    expect(document).toContain('file: Create pet.body.json');
    expect(document).not.toContain('Fido');
  });

  it('writes enabled only when a row is switched off', () => {
    const document = projectFiles(apiProject()).get('apis/Petstore/requests/Pets/Get pet by id.request.yaml')!;
    expect(document).toContain('enabled: false');
    expect(document.match(/enabled:/g)).toHaveLength(1);
  });

  it('omits empty tables, settings and an inherited auth is still written', () => {
    const document = projectFiles(apiProject()).get('apis/Orders/requests/List orders.request.yaml')!;
    expect(document).not.toContain('query:');
    expect(document).not.toContain('settings:');
    expect(document).toContain('type: inherit');
  });
});

describe('round trip through a folder', () => {
  it('loads back into the same model, with no problems', async () => {
    const dir = await tempProjectDir();
    const project = apiProject();
    await saveProject(project, dir);

    const { project: loaded, problems } = await loadProject(dir);

    expect(problems).toEqual([]);
    expect(loaded.apis).toEqual(project.apis);
    await rm(dir, { recursive: true, force: true });
  });

  it('is byte-stable: saving what was loaded changes nothing', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    const { project: loaded } = await loadProject(dir);

    const result = await saveProject(loaded, dir);

    expect(result.written).toEqual([]);
    expect(result.removed).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('renaming a request touches exactly its two files', async () => {
    const dir = await tempProjectDir();
    const project = apiProject();
    await saveProject(project, dir);
    const before = await listTree(dir);

    const renamed: Project = {
      ...project,
      apis: project.apis.map((api) =>
        api.id !== 'A1'
          ? api
          : {
              ...api,
              folders: api.folders.map((folder) =>
                folder.id !== 'F1'
                  ? folder
                  : {
                      ...folder,
                      requests: folder.requests.map((request) =>
                        request.id !== 'R2' ? request : { ...request, name: 'Add pet', slug: 'Add pet' },
                      ),
                    },
              ),
            },
      ),
    };
    const result = await saveProject(renamed, dir);

    expect(result.written).toEqual([
      'apis/Petstore/requests/Pets/Add pet.body.json',
      'apis/Petstore/requests/Pets/Add pet.request.yaml',
    ]);
    expect(result.removed).toEqual([
      'apis/Petstore/requests/Pets/Create pet.body.json',
      'apis/Petstore/requests/Pets/Create pet.request.yaml',
    ]);
    expect(await listTree(dir)).toHaveLength(before.length);
    await rm(dir, { recursive: true, force: true });
  });

  it('deleting an API takes its whole folder, definition cache included', async () => {
    const dir = await tempProjectDir();
    const project = apiProject();
    await saveProject(project, dir);
    await mkdir(join(dir, APIS_DIR, 'Petstore', 'definition'), { recursive: true });
    await writeFile(join(dir, APIS_DIR, 'Petstore', 'definition', 'openapi.json'), '{}');

    const result = await saveProject({ ...project, apis: project.apis.filter((api) => api.id !== 'A1') }, dir);

    expect(result.removed).toContain('apis/Petstore');
    expect(await listTree(dir)).toEqual([
      'apis/Orders/api.yaml',
      'apis/Orders/requests/List orders.request.yaml',
      'wirebench.yaml',
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves a foreign file inside an API alone', async () => {
    const dir = await tempProjectDir();
    const project = apiProject();
    await saveProject(project, dir);
    await writeFile(join(dir, APIS_DIR, 'Petstore', 'requests', 'NOTES.md'), 'mine');

    await saveProject(project, dir);

    expect(await readFile(join(dir, APIS_DIR, 'Petstore', 'requests', 'NOTES.md'), 'utf8')).toBe('mine');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('problems a damaged apis/ folder reports', () => {
  it('skips a directory with no api.yaml', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    await mkdir(join(dir, APIS_DIR, 'Ghost'), { recursive: true });

    const { project, problems } = await loadProject(dir);

    expect(project.apis.map((api) => api.slug)).toEqual(['Petstore', 'Orders']);
    expect(problems).toEqual([
      {
        code: 'missing-api-file',
        message: 'Folder "Ghost" has no api.yaml and was skipped',
        file: 'apis/Ghost/api.yaml',
      },
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a request whose raw body file is gone with an empty body', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    await rm(join(dir, APIS_DIR, 'Petstore', 'requests', 'Pets', 'Create pet.body.json'));

    const { project, problems } = await loadProject(dir);

    const request = project.apis[0]!.folders[0]!.requests.find((r) => r.id === 'R2')!;
    expect(request.body).toEqual({ kind: 'raw', language: 'json', text: '' });
    expect(problems).toEqual([
      {
        code: 'missing-body',
        message: 'Request "Create pet" has no body file; loaded with an empty body',
        file: 'apis/Petstore/requests/Pets/Create pet.body.json',
      },
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a stray file in a request directory', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    await writeFile(join(dir, APIS_DIR, 'Orders', 'requests', 'leftover.body.json'), '{}');

    const { problems } = await loadProject(dir);

    expect(problems).toEqual([
      {
        code: 'orphan-request-file',
        message: '"leftover.body.json" does not belong to any request',
        file: 'apis/Orders/requests/leftover.body.json',
      },
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it('adopts a directory someone created by hand as a folder', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    const byHand = join(dir, APIS_DIR, 'Orders', 'requests', 'Drafts');
    await mkdir(byHand, { recursive: true });
    await cp(join(dir, APIS_DIR, 'Orders', 'requests', 'List orders.request.yaml'), join(byHand, 'Copy.request.yaml'));

    const { project, problems } = await loadProject(dir);

    const folder = project.apis.find((api) => api.slug === 'Orders')!.folders[0]!;
    expect(folder).toMatchObject({ name: 'Drafts', slug: 'Drafts' });
    expect(folder.requests).toHaveLength(1);
    expect(problems).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('skips a folder nested deeper than the cap, and refuses to write one', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    let deep = join(dir, APIS_DIR, 'Orders', 'requests');
    for (let n = 0; n <= MAX_FOLDER_DEPTH; n += 1) {
      deep = join(deep, `d${String(n)}`);
    }
    await mkdir(deep, { recursive: true });

    const { problems } = await loadProject(dir);
    expect(problems.map((problem) => problem.code)).toContain('folder-too-deep');

    // The same tree, built in the model, is refused before any path is constructed.
    let folder = createFolder('leaf', { id: 'deep-leaf' });
    for (let n = 0; n <= MAX_FOLDER_DEPTH; n += 1) {
      folder = createFolder(`d${String(n)}`, { id: `deep-${String(n)}`, folders: [folder] });
    }
    const tooDeep: Project = {
      ...createProject('Deep', { id: 'P' }),
      apis: [createApi('A', { id: 'A', folders: [folder] })],
    };
    expect(() => projectFiles(tooDeep)).toThrow(ProjectError);
    expect(() => projectFiles(tooDeep)).toThrow(/more than 8 deep/);

    await rm(dir, { recursive: true, force: true });
  });

  it('skips an API whose slug an interface already uses, because an override key would be ambiguous', async () => {
    const dir = await tempProjectDir();
    const project = apiProject();
    await saveProject(project, dir);
    await mkdir(join(dir, 'interfaces', 'Orders'), { recursive: true });
    await writeFile(
      join(dir, 'interfaces', 'Orders', 'interface.yaml'),
      [
        'kind: soap',
        'id: I1',
        'name: Orders',
        'order: 0',
        'definitionUrl: http://x.test/o.wsdl',
        'cacheDefinition: true',
        'endpoints: []',
        'operations: []',
        'wsa:',
        '  enabled: false',
        '',
      ].join('\n'),
    );

    const { project: loaded, problems } = await loadProject(dir);

    expect(loaded.apis.map((api) => api.slug)).toEqual(['Petstore']);
    expect(problems).toEqual([
      {
        code: 'api-slug-conflict',
        message: 'API "Orders" and an interface share the slug "Orders"; the API was skipped',
        file: 'apis/Orders/api.yaml',
      },
    ]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('a kind this build does not support', () => {
  it('refuses a request file of an unknown kind by name instead of guessing', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    const file = join(dir, APIS_DIR, 'Orders', 'requests', 'List orders.request.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('kind: rest', 'kind: graphql'));

    const error = (await loadProject(dir).catch((e: unknown) => e)) as ProjectError;

    expect(error).toBeInstanceOf(ProjectError);
    expect(error.code).toBe('project-kind-not-supported');
    expect(error.message).toContain('"graphql"');
    expect(error.details).toMatchObject({ kind: 'graphql', supported: ['soap', 'rest', 'grpc'] });
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses an api.yaml of an unknown kind the same way', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    const file = join(dir, APIS_DIR, 'Orders', 'api.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('kind: rest', 'kind: graphql'));

    const error = (await loadProject(dir).catch((e: unknown) => e)) as ProjectError;

    expect(error.code).toBe('project-kind-not-supported');
    await rm(dir, { recursive: true, force: true });
  });
});
