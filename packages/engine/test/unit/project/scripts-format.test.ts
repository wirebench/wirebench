/**
 * A request's scripts on disk (format 6, #63): the `scripts` key in the request file, each script
 * in a file beside it named from the slug, and the problems a missing or oversized file raises.
 */
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { SCRIPT_LIMITS } from '../../../src/script/sandbox/model.js';
import { tempProjectDir } from './fixture.js';

const V5_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v5', 'project');
const REQUESTS = 'apis/Shop/requests';
const SOAP_DIR = 'interfaces/CountryInfo/operations/ListOfCountryNamesByCode';

let dir: string;
beforeEach(async () => {
  dir = await tempProjectDir();
  await cp(V5_DIR, dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SCRIPTS: RequestScripts = {
  pre: { text: 'request.headers.set("X-Sig", crypto.hash("sha256", request.body.text));\n' },
  post: { text: 'test("created", () => expect(response.status).toBe(201));\n' },
  api: 'wirebench',
  enabled: true,
  secrets: ['signing-key'],
  timeoutMs: 2000,
};

function restRequest(project: Project): RestRequestDef {
  const request = project.apis[0]?.requests[0];
  if (request === undefined) throw new Error('fixture has no REST request');
  return request;
}

function withRestScripts(project: Project, scripts: RequestScripts | undefined, slug?: string): Project {
  const api = project.apis[0]!;
  const request = restRequest(project);
  const next: RestRequestDef = { ...request, ...(slug !== undefined ? { slug } : {}) };
  const changed: RestRequestDef = { ...next };
  if (scripts === undefined) {
    delete (changed as { scripts?: RequestScripts }).scripts;
  } else {
    (changed as { scripts?: RequestScripts }).scripts = scripts;
  }
  return { ...project, apis: [{ ...api, requests: [changed] }] };
}

describe('request scripts on disk', () => {
  it('write the scripts key and a file per script, and load back the same', async () => {
    const { project } = await loadProject(dir);
    await saveProject(withRestScripts(project, SCRIPTS), dir);

    const yaml = await readFile(join(dir, REQUESTS, 'Create cart.request.yaml'), 'utf8');
    expect(yaml).toContain(
      [
        'scripts:',
        '  post: Create cart.post.ts',
        '  pre: Create cart.pre.ts',
        '  secrets:',
        '    - signing-key',
        '  timeoutMs: 2000',
      ].join('\n'),
    );
    expect(await readFile(join(dir, REQUESTS, 'Create cart.pre.ts'), 'utf8')).toBe(SCRIPTS.pre!.text);
    expect(await readFile(join(dir, REQUESTS, 'Create cart.post.ts'), 'utf8')).toBe(SCRIPTS.post!.text);

    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    expect(restRequest(reloaded.project).scripts).toEqual(SCRIPTS);
  });

  it('write a Postman script as .js with its api and enabled flag', async () => {
    const { project } = await loadProject(dir);
    const postman: RequestScripts = {
      post: { text: 'pm.test("ok", () => {});\n' },
      api: 'postman',
      enabled: false,
      secrets: [],
    };
    await saveProject(withRestScripts(project, postman), dir);

    const yaml = await readFile(join(dir, REQUESTS, 'Create cart.request.yaml'), 'utf8');
    expect(yaml).toContain(
      ['scripts:', '  api: postman', '  enabled: false', '  post: Create cart.post.js'].join('\n'),
    );
    expect((await loadProject(dir)).project.apis[0]?.requests[0]?.scripts).toEqual(postman);
  });

  it('move the scripts with a renamed request, and remove them with the scripts', async () => {
    const { project } = await loadProject(dir);
    await saveProject(withRestScripts(project, SCRIPTS), dir);
    await saveProject(withRestScripts((await loadProject(dir)).project, SCRIPTS, 'Checkout'), dir);
    expect((await readdir(join(dir, REQUESTS))).sort()).toEqual([
      'Checkout.body.json',
      'Checkout.post.ts',
      'Checkout.pre.ts',
      'Checkout.request.yaml',
    ]);

    await saveProject(withRestScripts((await loadProject(dir)).project, undefined), dir);
    expect((await readdir(join(dir, REQUESTS))).sort()).toEqual(['Checkout.body.json', 'Checkout.request.yaml']);
  });

  it('keep scripts on a SOAP request beside its envelope', async () => {
    const { project } = await loadProject(dir);
    const iface = project.interfaces[0]!;
    const operation = iface.operations[0]!;
    const [first, ...rest] = operation.requests;
    const changed: Project = {
      ...project,
      interfaces: [
        { ...iface, operations: [{ ...operation, requests: [{ ...first!, scripts: SCRIPTS }, ...rest] }] },
        ...project.interfaces.slice(1),
      ],
    };
    await saveProject(changed, dir);
    expect(await readFile(join(dir, SOAP_DIR, `${first!.slug}.pre.ts`), 'utf8')).toBe(SCRIPTS.pre!.text);
    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    expect(reloaded.project.interfaces[0]?.operations[0]?.requests[0]?.scripts).toEqual(SCRIPTS);
  });

  it('report a missing script file, and load the request with that script marked', async () => {
    const { project } = await loadProject(dir);
    await saveProject(withRestScripts(project, SCRIPTS), dir);
    await rm(join(dir, REQUESTS, 'Create cart.pre.ts'));

    const { project: reloaded, problems } = await loadProject(dir);
    expect(problems).toEqual([
      expect.objectContaining({ code: 'script-file-missing', file: `${REQUESTS}/Create cart.pre.ts` }),
    ]);
    expect(restRequest(reloaded).scripts?.pre).toEqual({ text: '', problem: 'script-file-missing' });
  });

  it('report a script over the size limit, and keep its text for the next save', async () => {
    const { project } = await loadProject(dir);
    await saveProject(withRestScripts(project, SCRIPTS), dir);
    const big = `// ${'x'.repeat(SCRIPT_LIMITS.fileBytes)}\n`;
    await writeFile(join(dir, REQUESTS, 'Create cart.post.ts'), big);

    const loaded = await loadProject(dir);
    expect(loaded.problems).toEqual([expect.objectContaining({ code: 'script-too-large' })]);
    expect(restRequest(loaded.project).scripts?.post).toEqual({ text: big, problem: 'script-too-large' });
    await saveProject(loaded.project, dir);
    expect(await readFile(join(dir, REQUESTS, 'Create cart.post.ts'), 'utf8')).toBe(big);
  });

  it('read the file named from the slug, whatever name the request file records', async () => {
    const { project } = await loadProject(dir);
    await saveProject(withRestScripts(project, SCRIPTS), dir);
    const yamlPath = join(dir, REQUESTS, 'Create cart.request.yaml');
    await writeFile(dir + '/../outside.ts', 'stolen');
    await writeFile(
      yamlPath,
      (await readFile(yamlPath, 'utf8')).replace('pre: Create cart.pre.ts', 'pre: ../../../../outside.ts'),
    );
    const { project: reloaded } = await loadProject(dir);
    expect(restRequest(reloaded).scripts?.pre).toEqual(SCRIPTS.pre);
    await rm(dir + '/../outside.ts', { force: true });
  });

  it('never load a script file the request does not name', async () => {
    await writeFile(join(dir, REQUESTS, 'Create cart.pre.ts'), 'log("hand placed")');
    const { project, problems } = await loadProject(dir);
    expect(restRequest(project).scripts).toBeUndefined();
    expect(problems).toEqual([expect.objectContaining({ code: 'orphan-request-file' })]);
  });
});
