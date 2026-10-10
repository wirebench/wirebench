// Two ways a save used to delete an API it should have kept: an API skipped on load because an
// interface has its slug, and an API (or request) renamed only by case on a file system that does
// not tell `Graph` from `graph`.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import { createInterface } from '../../../src/soap/model.js';
import { saveProject } from '../../../src/project/save.js';
import { createApi, createRestRequest, restApisOf, withRestApis } from '../../../src/rest/model.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-keeps-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const filesOf = async (path: string): Promise<string[]> =>
  (await readdir(path, { recursive: true })).map((name) => name.split('\\').join('/')).sort();

describe('saveProject keeps an API skipped for an interface slug conflict', () => {
  it('leaves the skipped API folder and its requests on disk', async () => {
    const api = createApi('X', {
      slug: 'X',
      baseUrl: 'http://x.test',
      requests: [createRestRequest('Get', { url: '/a' })],
    });
    const iface = createInterface('X', { slug: 'X', definitionUrl: 'http://x.test/wsdl' });
    await saveProject({ ...createProject('P'), containers: { rest: [api], soap: [iface] } }, dir);
    const before = await filesOf(join(dir, 'apis', 'X'));

    const loaded = await loadProject(dir);
    expect(loaded.problems.map((problem) => problem.code)).toEqual(['api-slug-conflict']);
    expect(restApisOf(loaded.project)).toEqual([]);

    const saved = await saveProject(loaded.project, dir);
    expect(saved.removed.filter((path) => path.startsWith('apis/'))).toEqual([]);
    expect(await filesOf(join(dir, 'apis', 'X'))).toEqual(before);
  });
});

describe('saveProject on a case-only rename', () => {
  it('keeps an API renamed from Graph to graph', async () => {
    const api = createApi('Graph', {
      slug: 'Graph',
      baseUrl: 'http://x.test',
      requests: [createRestRequest('Get', { url: '/a' })],
    });
    const project = { ...createProject('P'), containers: { rest: [api] } };
    await saveProject(project, dir);

    await saveProject(
      { ...project, containers: { ...project.containers, rest: [{ ...api, name: 'graph', slug: 'graph' }] } },
      dir,
    );

    expect(await readdir(join(dir, 'apis'))).toEqual(['graph']);
    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    expect(restApisOf(reloaded.project).map((loaded) => [loaded.slug, loaded.requests.length])).toEqual([['graph', 1]]);
  });

  it('keeps a request renamed from Get to get', async () => {
    const request = createRestRequest('Get', { url: '/a' });
    const api = createApi('Shop', { slug: 'Shop', baseUrl: 'http://x.test', requests: [request] });
    const project = { ...createProject('P'), containers: { rest: [api] } };
    await saveProject(project, dir);
    const named = (await filesOf(join(dir, 'apis', 'Shop'))).filter((file) => /get/i.test(file));
    expect(named).toHaveLength(1);

    await saveProject(withRestApis(project, [{ ...api, requests: [{ ...request, name: 'get', slug: 'get' }] }]), dir);

    const renamed = (await filesOf(join(dir, 'apis', 'Shop'))).filter((file) => /get/i.test(file));
    expect(renamed).toEqual([named[0]!.replace('Get', 'get')]);
    const reloaded = await loadProject(dir);
    expect(restApisOf(reloaded.project)[0]!.requests.map((loaded) => loaded.name)).toEqual(['get']);
  });
});
