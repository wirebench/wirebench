/**
 * Response examples on a REST request (format 7, #64): the `examples:` list in the request file,
 * each body in `<slug>.examples/<id>.body.<ext>` beside it, and that folder moving and going with
 * its request exactly as the request's body file does.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { createApi, createFolder, createRestRequest, entry, exampleBodyExtension } from '../../../src/rest/model.js';
import type { RestRequestDef, RestResponseExample } from '../../../src/rest/model.js';
import { listTree, tempProjectDir } from '../project/fixture.js';

const REQUESTS = 'apis/pets/requests';

const EXAMPLES: readonly RestResponseExample[] = [
  {
    id: '01J0EXAMPLE0000000000000001',
    name: '200 OK — recorded 2026-10-04',
    status: 200,
    statusText: 'OK',
    headers: [entry('Content-Type', 'application/json')],
    contentType: 'application/json',
    body: '{"id":1}',
  },
  {
    id: '01J0EXAMPLE0000000000000002',
    name: '404 Not Found — recorded 2026-10-04',
    status: 404,
    statusText: 'Not Found',
    headers: [],
  },
];

function withExamples(request: RestRequestDef): RestRequestDef {
  return { ...request, examples: EXAMPLES };
}

function petsProject(requests: readonly RestRequestDef[]): Project {
  return {
    ...createProject('Pets', { id: 'P1' }),
    apis: [createApi('pets', { id: 'A1', baseUrl: 'https://pets.test', requests })],
  };
}

function getPet(): RestRequestDef {
  return withExamples(createRestRequest('Get pet', { id: 'R1', slug: 'get-pet', method: 'GET', url: '/pets/1' }));
}

let dir: string;
beforeEach(async () => {
  dir = await tempProjectDir();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('response examples on disk', () => {
  it('round-trips response examples, bodies beside the request', async () => {
    const project = petsProject([getPet()]);
    const files = projectFiles(project);
    expect(files.get(`${REQUESTS}/get-pet.examples/01J0EXAMPLE0000000000000001.body.json`)).toBe('{"id":1}');
    const document = files.get(`${REQUESTS}/get-pet.request.yaml`)!;
    expect(document).toContain('file: get-pet.examples/01J0EXAMPLE0000000000000001.body.json');
    expect(document).not.toContain('{"id":1}');

    await saveProject(project, dir);
    const { project: loaded, problems } = await loadProject(dir);

    expect(problems).toEqual([]);
    expect(loaded.apis[0]!.folders).toEqual([]);
    expect(loaded.apis[0]!.requests[0]!.examples).toEqual(EXAMPLES);
  });

  it('is byte-stable: saving what was loaded changes nothing', async () => {
    await saveProject(petsProject([getPet()]), dir);
    const { project: loaded } = await loadProject(dir);

    const result = await saveProject(loaded, dir);

    expect(result.written).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('loads a request written before examples with none', async () => {
    await saveProject(petsProject([]), dir);
    await mkdir(join(dir, REQUESTS), { recursive: true });
    await writeFile(
      join(dir, REQUESTS, 'a.request.yaml'),
      'kind: rest\nid: 01J0A\nname: a\norder: 0\nmethod: GET\nurl: /\n',
    );

    const { project, problems } = await loadProject(dir);

    expect(problems).toEqual([]);
    expect(project.apis[0]!.requests[0]!.examples).toBeUndefined();
  });

  it('names example body files by content type', () => {
    expect(exampleBodyExtension('application/json; charset=utf-8')).toBe('json');
    expect(exampleBodyExtension('application/soap+xml')).toBe('xml');
    expect(exampleBodyExtension('text/html')).toBe('html');
    expect(exampleBodyExtension(undefined)).toBe('txt');
  });

  it('loads an example whose body file is gone without a body, and says so', async () => {
    await saveProject(petsProject([getPet()]), dir);
    await rm(join(dir, REQUESTS, 'get-pet.examples', '01J0EXAMPLE0000000000000001.body.json'));

    const { project, problems } = await loadProject(dir);

    expect(project.apis[0]!.requests[0]!.examples![0]!.body).toBeUndefined();
    expect(problems).toEqual([
      expect.objectContaining({
        code: 'missing-body',
        file: `${REQUESTS}/get-pet.examples/01J0EXAMPLE0000000000000001.body.json`,
      }),
    ]);
  });

  it.each([
    ['outside the request directory', '../../../../outside.txt'],
    ["into another request's examples folder", 'other.examples/01J0EXAMPLE0000000000000001.body.json'],
    ['into a subfolder', 'Drafts/01J0EXAMPLE0000000000000001.body.json'],
    ["under another example's id", 'get-pet.examples/01J0EXAMPLE0000000000000009.body.json'],
  ])('loads an example whose file points %s without a body, and says so', async (_, file) => {
    await saveProject(petsProject([getPet(), createRestRequest('Other', { id: 'R2', slug: 'other' })]), dir);
    // A file the entry must never be read from, whichever of these it names.
    for (const target of ['other.examples', 'Drafts', 'get-pet.examples']) {
      await mkdir(join(dir, REQUESTS, target), { recursive: true });
    }
    for (const target of [
      'other.examples/01J0EXAMPLE0000000000000001.body.json',
      'Drafts/01J0EXAMPLE0000000000000001.body.json',
      'get-pet.examples/01J0EXAMPLE0000000000000009.body.json',
    ]) {
      await writeFile(join(dir, REQUESTS, target), 'not this example');
    }
    const requestFile = join(dir, REQUESTS, 'get-pet.request.yaml');
    const text = await readFile(requestFile, 'utf8');
    await writeFile(
      requestFile,
      text.replace('file: get-pet.examples/01J0EXAMPLE0000000000000001.body.json', `file: ${file}`),
    );

    const { project, problems } = await loadProject(dir);

    const request = project.apis[0]!.requests.find((r) => r.id === 'R1')!;
    expect(request.examples![0]!.body).toBeUndefined();
    expect(problems).toContainEqual(
      expect.objectContaining({ code: 'example-file-invalid', file: 'apis/pets/requests/get-pet.request.yaml' }),
    );
  });

  it('refuses to write two examples with the same id, which would share one body file', () => {
    const request = getPet();
    const twice = { ...request, examples: [EXAMPLES[0]!, { ...EXAMPLES[0]!, name: 'again', body: '{"id":2}' }] };

    expect(() => projectFiles(petsProject([twice]))).toThrow(expect.objectContaining({ code: 'duplicate-slug' }));
  });

  it('walks a folder named like an examples folder as a folder when it holds requests', async () => {
    const inner = createRestRequest('Inner', {
      id: 'R3',
      slug: 'inner',
      method: 'POST',
      body: { kind: 'raw', language: 'json', text: '{}' },
    });
    // The request has no examples, so nothing of its own is written into the folder that shares the name.
    const project = petsProject([{ ...getPet(), examples: [] }]);
    const api = project.apis[0]!;
    const withFolder: Project = {
      ...project,
      apis: [
        {
          ...api,
          folders: [createFolder('get-pet.examples', { id: 'F1', slug: 'get-pet.examples', requests: [inner] })],
        },
      ],
    };
    await saveProject(withFolder, dir);

    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(loaded.apis[0]!.folders.map((folder) => folder.slug)).toEqual(['get-pet.examples']);
    expect(loaded.apis[0]!.folders[0]!.requests.map((r) => r.id)).toEqual(['R3']);

    const result = await saveProject(loaded, dir);
    expect(result.removed).toEqual([]);
    expect(await listTree(join(dir, REQUESTS, 'get-pet.examples'))).toEqual([
      'folder.yaml',
      'inner.body.json',
      'inner.request.yaml',
    ]);
  });

  it('moves the examples folder with a renamed request', async () => {
    await saveProject(petsProject([getPet()]), dir);
    const { project } = await loadProject(dir);
    const request = project.apis[0]!.requests[0]!;

    await saveProject(petsProject([{ ...request, name: 'Fetch pet', slug: 'fetch-pet' }]), dir);

    expect(await listTree(join(dir, REQUESTS))).toEqual([
      'fetch-pet.examples/01J0EXAMPLE0000000000000001.body.json',
      'fetch-pet.request.yaml',
    ]);
    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    expect(reloaded.project.apis[0]!.requests[0]!.examples).toEqual(EXAMPLES);
  });

  it('deletes the examples folder with its request', async () => {
    await saveProject(petsProject([getPet(), createRestRequest('Other', { id: 'R2', slug: 'other' })]), dir);

    const result = await saveProject(petsProject([createRestRequest('Other', { id: 'R2', slug: 'other' })]), dir);

    expect(result.removed).toContain(`${REQUESTS}/get-pet.examples/01J0EXAMPLE0000000000000001.body.json`);
    expect((await readdir(join(dir, REQUESTS))).sort()).toEqual(['other.request.yaml']);
  });

  it("removes a deleted example's body file and keeps the others", async () => {
    const both: readonly RestResponseExample[] = [
      EXAMPLES[0]!,
      { ...EXAMPLES[1]!, contentType: 'text/plain', body: 'gone' },
    ];
    const request = { ...getPet(), examples: both };
    await saveProject(petsProject([request]), dir);

    const result = await saveProject(petsProject([{ ...request, examples: [both[0]!] }]), dir);

    expect(result.removed).toEqual([`${REQUESTS}/get-pet.examples/01J0EXAMPLE0000000000000002.body.txt`]);
    expect(await listTree(join(dir, REQUESTS))).toEqual([
      'get-pet.examples/01J0EXAMPLE0000000000000001.body.json',
      'get-pet.request.yaml',
    ]);
  });

  it('leaves a foreign file in an examples folder alone, and the folder with it', async () => {
    await saveProject(petsProject([getPet()]), dir);
    await mkdir(join(dir, REQUESTS, 'get-pet.examples'), { recursive: true });
    await writeFile(join(dir, REQUESTS, 'get-pet.examples', 'NOTES.md'), 'mine');

    await saveProject(petsProject([]), dir);

    expect(await readFile(join(dir, REQUESTS, 'get-pet.examples', 'NOTES.md'), 'utf8')).toBe('mine');
  });
});
