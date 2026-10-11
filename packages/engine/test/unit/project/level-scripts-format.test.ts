/**
 * An API's, an interface's and a folder's scripts on disk (format 9, #334): the `scripts` key on
 * `api.yaml`, `interface.yaml` and `folder.yaml`, each script in a fixed file beside it, and the one
 * clash a folder's files can have with a request slugged `folder`.
 */
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGrpcApi,
  createGrpcFolder,
  createGrpcRequest,
  grpcApisOf,
  withGrpcApis,
} from '../../../src/grpc/model.js';
import { loadProject } from '../../../src/project/load.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { createFolder, restApisOf, withRestApis } from '../../../src/rest/model.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { soapInterfacesOf, withSoapInterfaces } from '../../../src/soap/model.js';
import { tempProjectDir } from './fixture.js';

const V5_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v5', 'project');
const SHOP = 'apis/Shop';
const SOAP_IFACE = 'interfaces/CountryInfo';

let dir: string;
beforeEach(async () => {
  dir = await tempProjectDir();
  await cp(V5_DIR, dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const API_SCRIPTS: RequestScripts = {
  pre: { text: 'request.headers.set("X-Api", "1");\n' },
  post: { text: 'test("ok", () => expect(response.status).toBe(200));\n' },
  api: 'wirebench',
  enabled: true,
  secrets: ['api_key'],
};

const FOLDER_SCRIPTS: RequestScripts = {
  pre: { text: 'log("folder");\n' },
  api: 'wirebench',
  enabled: false,
  secrets: [],
  timeoutMs: 500,
};

/** `owner` without its `scripts` key. */
function withoutScripts<T extends { readonly scripts?: RequestScripts }>(owner: T): T {
  return Object.fromEntries(Object.entries(owner).filter(([key]) => key !== 'scripts')) as T;
}

/** The fixture's Shop API with its one request moved into a folder `Orders`, and `scripts` on both. */
function shopWithLevels(project: Project, folderScripts: RequestScripts | null = FOLDER_SCRIPTS): Project {
  const api = restApisOf(project)[0]!;
  const folder = createFolder('Orders', {
    id: 'folder-orders',
    requests: api.requests,
    ...(folderScripts !== null ? { scripts: folderScripts } : {}),
  });
  return withRestApis(project, [{ ...api, scripts: API_SCRIPTS, requests: [], folders: [folder] }]);
}

describe('level scripts on disk', () => {
  it('write an API’s and a folder’s scripts beside their files, and load back the same', async () => {
    const { project } = await loadProject(dir);
    await saveProject(shopWithLevels(project), dir);

    expect(await readFile(join(dir, SHOP, 'api.yaml'), 'utf8')).toContain(
      ['scripts:', '  post: api.post.ts', '  pre: api.pre.ts', '  secrets:', '    - api_key'].join('\n'),
    );
    expect(await readFile(join(dir, SHOP, 'api.pre.ts'), 'utf8')).toBe(API_SCRIPTS.pre!.text);
    expect(await readFile(join(dir, SHOP, 'api.post.ts'), 'utf8')).toBe(API_SCRIPTS.post!.text);
    expect(await readFile(join(dir, SHOP, 'requests/Orders/folder.yaml'), 'utf8')).toContain(
      ['scripts:', '  enabled: false', '  pre: folder.pre.ts', '  timeoutMs: 500'].join('\n'),
    );
    expect(await readFile(join(dir, SHOP, 'requests/Orders/folder.pre.ts'), 'utf8')).toBe(FOLDER_SCRIPTS.pre!.text);

    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    const api = restApisOf(reloaded.project)[0]!;
    expect(api.scripts).toEqual(API_SCRIPTS);
    expect(api.folders[0]?.scripts).toEqual(FOLDER_SCRIPTS);
  });

  it('remove a level’s files with its scripts', async () => {
    const { project } = await loadProject(dir);
    await saveProject(shopWithLevels(project), dir);
    const loaded = (await loadProject(dir)).project;
    const api = restApisOf(loaded)[0]!;
    const bareFolder = withoutScripts(api.folders[0]!);
    await saveProject(withRestApis(loaded, [{ ...withoutScripts(api), folders: [bareFolder] }]), dir);

    expect((await readdir(join(dir, SHOP))).sort()).toEqual(['api.yaml', 'requests']);
    expect(await readdir(join(dir, SHOP, 'requests/Orders'))).not.toContain('folder.pre.ts');
  });

  it('keep scripts on a SOAP interface beside interface.yaml', async () => {
    const { project } = await loadProject(dir);
    const [iface, ...rest] = soapInterfacesOf(project);
    await saveProject(withSoapInterfaces(project, [{ ...iface!, scripts: API_SCRIPTS }, ...rest]), dir);

    expect(await readFile(join(dir, SOAP_IFACE, 'interface.pre.ts'), 'utf8')).toBe(API_SCRIPTS.pre!.text);
    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    expect(soapInterfacesOf(reloaded.project)[0]?.scripts).toEqual(API_SCRIPTS);

    const [loaded, ...others] = soapInterfacesOf(reloaded.project);
    await saveProject(withSoapInterfaces(reloaded.project, [withoutScripts(loaded!), ...others]), dir);
    expect(await readdir(join(dir, SOAP_IFACE))).not.toContain('interface.pre.ts');
  });

  it('keep scripts on a gRPC API and folder', async () => {
    const { project } = await loadProject(dir);
    const request = createGrpcRequest('Say hello', { id: 'grpc-req', service: 'hello.Greeter', method: 'SayHello' });
    const folder = createGrpcFolder('Greeter', { id: 'grpc-folder', requests: [request], scripts: FOLDER_SCRIPTS });
    const api = { ...createGrpcApi('Hello', { id: 'grpc-api', target: 'localhost:50051' }), folders: [folder] };
    await saveProject(withGrpcApis(project, [{ ...api, scripts: API_SCRIPTS }]), dir);

    expect(await readFile(join(dir, 'apis/Hello/api.pre.ts'), 'utf8')).toBe(API_SCRIPTS.pre!.text);
    expect(await readFile(join(dir, 'apis/Hello/requests/Greeter/folder.pre.ts'), 'utf8')).toBe(
      FOLDER_SCRIPTS.pre!.text,
    );
    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    const loaded = grpcApisOf(reloaded.project)[0]!;
    expect(loaded.scripts).toEqual(API_SCRIPTS);
    expect(loaded.folders[0]?.scripts).toEqual(FOLDER_SCRIPTS);
  });

  it('report a missing level script file and mark that script', async () => {
    const { project } = await loadProject(dir);
    await saveProject(shopWithLevels(project), dir);
    await rm(join(dir, SHOP, 'api.post.ts'));
    await rm(join(dir, SHOP, 'requests/Orders/folder.pre.ts'));

    const { project: reloaded, problems } = await loadProject(dir);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'script-file-missing', file: `${SHOP}/api.post.ts` }),
        expect.objectContaining({ code: 'script-file-missing', file: `${SHOP}/requests/Orders/folder.pre.ts` }),
      ]),
    );
    const api = restApisOf(reloaded)[0]!;
    expect(api.scripts?.post).toEqual({ text: '', problem: 'script-file-missing' });
    expect(api.folders[0]?.scripts?.pre).toEqual({ text: '', problem: 'script-file-missing' });
  });

  it('never claim a folder script file the folder does not name', async () => {
    const { project } = await loadProject(dir);
    await saveProject(shopWithLevels(project, null), dir);
    await writeFile(join(dir, SHOP, 'requests/Orders/folder.pre.ts'), 'log("hand placed")');
    const { project: reloaded, problems } = await loadProject(dir);
    expect(restApisOf(reloaded)[0]?.folders[0]?.scripts).toBeUndefined();
    expect(problems).toEqual([expect.objectContaining({ code: 'orphan-request-file' })]);
  });

  describe('a request slugged "folder"', () => {
    const REQUEST_SCRIPTS: RequestScripts = {
      pre: { text: 'log("request");\n' },
      api: 'wirebench',
      enabled: true,
      secrets: [],
    };

    function withFolderRequest(project: Project, requestScripts: RequestScripts | undefined): Project {
      const levelled = shopWithLevels(project);
      const api = restApisOf(levelled)[0]!;
      const folder = api.folders[0]!;
      const request = {
        ...folder.requests[0]!,
        slug: 'folder',
        ...(requestScripts !== undefined ? { scripts: requestScripts } : {}),
      };
      return withRestApis(levelled, [{ ...api, folders: [{ ...folder, requests: [request] }] }]);
    }

    it('refuses to save when both it and its folder have scripts', async () => {
      const { project } = await loadProject(dir);
      await expect(saveProject(withFolderRequest(project, REQUEST_SCRIPTS), dir)).rejects.toMatchObject({
        code: 'duplicate-slug',
      });
    });

    it('saves beside a scripted folder when the request has no scripts', async () => {
      const { project } = await loadProject(dir);
      await saveProject(withFolderRequest(project, undefined), dir);
      const reloaded = await loadProject(dir);
      expect(reloaded.problems).toEqual([]);
      expect(restApisOf(reloaded.project)[0]?.folders[0]?.scripts).toEqual(FOLDER_SCRIPTS);
    });

    it('loses the file to the folder on load, as a clash', async () => {
      const { project } = await loadProject(dir);
      await saveProject(withFolderRequest(project, undefined), dir);
      // Hand-edit the request file to claim scripts too: the folder's file is the one on disk.
      const yamlPath = join(dir, SHOP, 'requests/Orders/folder.request.yaml');
      await writeFile(yamlPath, `${await readFile(yamlPath, 'utf8')}scripts:\n  pre: folder.pre.ts\n`);

      const { project: reloaded, problems } = await loadProject(dir);
      expect(problems).toEqual([
        expect.objectContaining({ code: 'script-file-clash', file: `${SHOP}/requests/Orders/folder.pre.ts` }),
      ]);
      const folder = restApisOf(reloaded)[0]!.folders[0]!;
      expect(folder.scripts).toEqual(FOLDER_SCRIPTS);
      expect(folder.requests[0]?.scripts?.pre).toEqual({ text: '', problem: 'script-file-missing' });
    });
  });
});
