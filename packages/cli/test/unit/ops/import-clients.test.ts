import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { grpcApisOf, loadProject, restApisOf, wsApisOf } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { importOp, writeScripts } from '../../../src/ops/import.js';
import { emptyProject, removeTempDirs, tempDir, updateProject } from './helpers.js';

afterEach(removeTempDirs);

const INSOMNIA = resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'fixtures', 'insomnia', 'crafted');

/** A v4 export whose base environment holds a plain value and a vault secret. */
const WITH_VAULT = JSON.stringify({
  _type: 'export',
  __export_format: 4,
  resources: [
    { _id: 'wrk_1', parentId: null, name: 'Vaulted', scope: 'collection', _type: 'workspace' },
    {
      _id: 'req_1',
      parentId: 'wrk_1',
      _type: 'request',
      name: 'Ping',
      method: 'GET',
      url: 'https://api.example.com/ping',
    },
    {
      _id: 'env_1',
      parentId: 'wrk_1',
      _type: 'environment',
      name: 'Base Environment',
      data: { region: 'eu', __insomnia_vault: { apiKey: 'c2VhbGVk' } },
    },
  ],
});

async function readError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
}

describe('op import: an Insomnia export', () => {
  it('imports an Insomnia file as its APIs with plain variables as properties', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: resolve(INSOMNIA, 'v4.json') }, fixture.base());

    expect(result.format).toBe('insomnia');
    expect(result.added.map((item) => [item.kind, item.name])).toEqual([
      ['rest', 'Orders API'],
      ['grpc', 'Orders API (gRPC)'],
      ['websocket', 'Orders API (WebSocket)'],
    ]);
    const { project } = await loadProject(fixture.dir);
    expect(restApisOf(project).map((api) => api.name)).toEqual(['Orders API']);
    expect(grpcApisOf(project)).toHaveLength(1);
    expect(wsApisOf(project)).toHaveLength(1);
    expect(project.properties).toMatchObject({
      baseUrl: 'https://api.example.com',
      tenant: 'base',
      'db.host': 'localhost',
    });
  });

  it('imports a v5 YAML export the same way', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: resolve(INSOMNIA, 'v5-collection.yaml') }, fixture.base());
    expect(result.format).toBe('insomnia');
    expect(result.added.map((item) => item.name)).toContain('Orders API');
  });

  it('leaves secrets out and names them (secret-not-imported)', async () => {
    const fixture = await emptyProject();
    const path = join(await tempDir(), 'vaulted.json');
    await writeFile(path, WITH_VAULT, 'utf8');
    const result = await runOp(importOp, { source: path }, fixture.base());

    const { project } = await loadProject(fixture.dir);
    expect(project.properties).toMatchObject({ region: 'eu' });
    expect(Object.keys(project.properties)).not.toContain('apiKey');
    expect(JSON.stringify(project)).not.toContain('c2VhbGVk');
    const secret = result.problems.find((problem) => problem.code === 'secret-not-imported');
    expect(secret?.message).toContain('apiKey');
    // The engine's own warning about vault secrets passes through.
    expect(result.problems.some((p) => p.message.includes('Vault secrets are not in the export'))).toBe(true);
  });

  it('reports environments as not imported', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: resolve(INSOMNIA, 'v4.json') }, fixture.base());
    expect(result.problems.map((problem) => problem.code)).toContain('environments-not-imported');
  });

  it('keeps an existing property value (property-kept)', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({ ...project, properties: { tenant: 'mine' } }));
    const result = await runOp(importOp, { source: resolve(INSOMNIA, 'v4.json') }, fixture.base());
    const { project } = await loadProject(fixture.dir);
    expect(project.properties['tenant']).toBe('mine');
    expect(result.problems.find((problem) => problem.code === 'property-kept')?.message).toContain('tenant');
  });

  it('saves the scripts as text under imported-scripts and names the proto files it cannot place', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: resolve(INSOMNIA, 'v4.json') }, fixture.base());
    const script = join(fixture.dir, 'imported-scripts', 'orders api', 'create order.pre.js');
    expect((await readFile(script, 'utf8')).length).toBeGreaterThan(0);
    expect(result.problems.find((problem) => problem.code === 'proto-not-imported')?.message).toContain('orders.proto');
  });

  it('refuses an Insomnia environment file', async () => {
    const fixture = await emptyProject();
    const error = await readError(
      runOp(importOp, { source: resolve(INSOMNIA, 'v5-environment.yaml') }, fixture.base()),
    );
    expect(error).toMatchObject({ code: 'environments-not-imported' });
  });

  it('refuses a Postman environment file with environments-not-imported', async () => {
    const fixture = await emptyProject();
    const path = join(await tempDir(), 'env.json');
    await writeFile(
      path,
      JSON.stringify({
        id: 'e1',
        name: 'Local',
        values: [{ key: 'a', value: 'b', enabled: true }],
        _postman_variable_scope: 'environment',
      }),
      'utf8',
    );
    const error = await readError(runOp(importOp, { source: path }, fixture.base()));
    expect(error).toMatchObject({ code: 'environments-not-imported' });
  });

  it('does not overwrite a script on a second import (EEXIST reported)', async () => {
    const fixture = await emptyProject();
    const source = resolve(INSOMNIA, 'v4.json');
    await runOp(importOp, { source }, fixture.base());
    const script = join(fixture.dir, 'imported-scripts', 'orders api', 'create order.pre.js');
    await writeFile(script, 'edited', 'utf8');
    const again = await runOp(importOp, { source }, fixture.base());
    expect(await readFile(script, 'utf8')).toBe('edited');
    expect(again.problems.find((p) => p.code === 'script-not-saved')?.message).toContain('already exists');
  });
});

describe('writeScripts guard', () => {
  it('refuses a path that leaves imported-scripts', async () => {
    const outer = await tempDir();
    const project = join(outer, 'project');
    await mkdir(project);
    const problems = await writeScripts(project, [{ path: '../escape.js', source: 'x' }]);
    expect(problems.map((p) => p.code)).toEqual(['script-not-saved']);
    expect(existsSync(join(outer, 'escape.js'))).toBe(false);
  });

  it('refuses to write through a symlinked imported-scripts', async () => {
    const outer = await tempDir();
    const project = join(outer, 'project');
    const elsewhere = join(outer, 'elsewhere');
    await mkdir(project);
    await mkdir(elsewhere);
    await symlink(elsewhere, join(project, 'imported-scripts'));
    const problems = await writeScripts(project, [{ path: 'imported-scripts/api/a.pre.js', source: 'x' }]);
    expect(problems.map((p) => p.code)).toEqual(['script-not-saved']);
    expect(existsSync(join(elsewhere, 'api', 'a.pre.js'))).toBe(false);
  });
});
