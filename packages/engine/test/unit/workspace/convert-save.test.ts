/**
 * A converted level on disk (spec §7, Review Focus 3): the backups are written before the save, so a
 * save that fails part way loses no script text; a save that succeeds writes the `.ts` files and
 * deletes the `.js` files the level no longer uses.
 */
import { access, cp, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrpcApi, grpcApisOf, withGrpcApis } from '../../../src/grpc/model.js';
import { createMcpFolder, createMcpServer, mcpServersOf, withMcpServers } from '../../../src/mcp/model.js';
import { nodeFs, writeFileAtomic, type FsLike } from '../../../src/project/fs.js';
import { loadProject } from '../../../src/project/load.js';
import { toAbsolute } from '../../../src/project/managed-files.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { restApisOf, withRestApis } from '../../../src/rest/model.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { applyConversions, proposeConversions } from '../../../src/script/convert/project.js';
import { tempProjectDir } from '../project/fixture.js';

const V5_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v5', 'project');
const REQUESTS = 'apis/Shop/requests';

const BRUNO: RequestScripts = {
  pre: { text: "bru.setVar('a', '1');\n" },
  post: { text: "test('ok', () => expect(res.getStatus()).to.equal(200));\n" },
  api: 'bruno',
  enabled: false,
  secrets: [],
};

let dir: string;
beforeEach(async () => {
  dir = await tempProjectDir();
  await cp(V5_DIR, dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = (relative: string): Promise<boolean> =>
  access(join(dir, relative)).then(
    () => true,
    () => false,
  );
const text = (relative: string): Promise<string> => readFile(join(dir, relative), 'utf8');

/** The fixture with its REST request's scripts layered and saved as `.js`. */
async function layeredProject(): Promise<Project> {
  const { project } = await loadProject(dir);
  const api = restApisOf(project)[0]!;
  const request = { ...api.requests[0]!, scripts: BRUNO };
  await saveProject(withRestApis(project, [{ ...api, requests: [request] }]), dir);
  expect(await text(`${REQUESTS}/Create cart.pre.js`)).toBe(BRUNO.pre!.text);
  return (await loadProject(dir)).project;
}

describe('a converted level on disk', () => {
  it('a failed save keeps the backups and every .js; a save that succeeds swaps .js for .ts', async () => {
    const project = await layeredProject();
    const [proposal] = proposeConversions(project);
    expect(proposal?.path).toEqual(['Shop', 'Create cart']);
    // A fresh listing of imported-scripts/ at Accept time: nothing is there yet.
    const { project: converted, applied } = applyConversions(
      project,
      [{ ownerId: proposal!.ownerId, fingerprint: proposal!.fingerprint }],
      new Set(),
    );
    expect(applied).toHaveLength(1);

    // The backups first, as the caller writes them.
    const backups = applied.flatMap((each) => each.backups);
    expect(backups.map((backup) => backup.path)).toEqual([
      'imported-scripts/shop/shop-create cart.pre.js',
      'imported-scripts/shop/shop-create cart.post.js',
    ]);
    for (const backup of backups) await writeFileAtomic(nodeFs, toAbsolute(dir, backup.path), backup.source);

    // A save that fails after it began writing: the second script file cannot be written.
    const failing: FsLike = {
      ...nodeFs,
      async writeFile(path, data) {
        if (path.includes('Create cart.post.ts')) throw new Error('disk full');
        await nodeFs.writeFile(path, data);
      },
    };
    await expect(saveProject(converted, dir, { fs: failing })).rejects.toThrow('disk full');
    // It had begun: the first script file was written before the failure.
    expect(await exists(`${REQUESTS}/Create cart.pre.ts`)).toBe(true);
    for (const backup of backups) expect(await text(backup.path)).toBe(backup.source);
    expect(await text(`${REQUESTS}/Create cart.pre.js`)).toBe(BRUNO.pre!.text);
    expect(await text(`${REQUESTS}/Create cart.post.js`)).toBe(BRUNO.post!.text);

    await saveProject(converted, dir);
    const result = proposal!.result;
    if (!result.ok) throw new Error('expected the level to convert');
    expect(await text(`${REQUESTS}/Create cart.pre.ts`)).toBe(result.pre);
    expect(await text(`${REQUESTS}/Create cart.post.ts`)).toBe(result.post);
    expect(await exists(`${REQUESTS}/Create cart.pre.js`)).toBe(false);
    expect(await exists(`${REQUESTS}/Create cart.post.js`)).toBe(false);
    for (const backup of backups) expect(await text(backup.path)).toBe(backup.source);

    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    expect(restApisOf(reloaded.project)[0]?.requests[0]?.scripts).toEqual({
      pre: { text: result.pre },
      post: { text: result.post },
      api: 'wirebench',
      enabled: false,
      secrets: [],
    });
  });

  it('a gRPC API level and an MCP folder level convert and save; the MCP server itself is not a level', async () => {
    const { project: base } = await loadProject(dir);
    const greeter = createGrpcApi('Greeter', { id: 'greeter', order: 1, target: 'localhost:50051', scripts: BRUNO });
    const admin = createMcpFolder('Admin', { id: 'admin', scripts: BRUNO });
    const tools = createMcpServer('Tools', { id: 'tools', order: 2, folders: [admin] });
    await saveProject(withMcpServers(withGrpcApis(base, [greeter]), [tools]), dir);
    const before = await scriptFiles();
    expect(before.filter((file) => file.endsWith('.js'))).toHaveLength(4);
    const { project } = await loadProject(dir);

    const proposals = proposeConversions(project);
    expect(proposals.map((proposal) => [proposal.ownerId, proposal.path])).toEqual([
      ['greeter', ['Greeter']],
      ['admin', ['Tools', 'Admin']],
    ]);
    expect(proposals.every((proposal) => proposal.result.ok)).toBe(true);
    expect(proposeConversions(project, 'tools').map((proposal) => proposal.ownerId)).toEqual(['admin']);

    const {
      project: converted,
      applied,
      refused,
    } = applyConversions(
      project,
      proposals.map(({ ownerId, fingerprint }) => ({ ownerId, fingerprint })),
      new Set(),
    );
    expect(refused).toEqual([]);
    const backups = applied.flatMap((each) => each.backups);
    expect(backups.map((backup) => backup.path)).toEqual([
      'imported-scripts/greeter/greeter.pre.js',
      'imported-scripts/greeter/greeter.post.js',
      'imported-scripts/tools/tools-admin.pre.js',
      'imported-scripts/tools/tools-admin.post.js',
    ]);
    for (const backup of backups) await writeFileAtomic(nodeFs, toAbsolute(dir, backup.path), backup.source);
    await saveProject(converted, dir);

    const after = await scriptFiles();
    expect(after.filter((file) => file.endsWith('.js'))).toEqual([]);
    expect(after.filter((file) => file.endsWith('.ts'))).toHaveLength(4);
    for (const backup of backups) expect(await text(backup.path)).toBe(backup.source);
    const reloaded = await loadProject(dir);
    expect(reloaded.problems).toEqual([]);
    expect(grpcApisOf(reloaded.project)[0]?.scripts?.api).toBe('wirebench');
    expect(mcpServersOf(reloaded.project)[0]?.folders[0]?.scripts?.api).toBe('wirebench');
  });
});

/** The script files of the gRPC and MCP containers, outside `imported-scripts/`. */
async function scriptFiles(): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(pre|post)\.(js|ts)$/.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((file) => !file.startsWith('imported-scripts') && !file.startsWith('apis/Shop'))
    .sort();
}
