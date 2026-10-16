import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { grpcApisOf, loadProject, restApisOf, wsApisOf } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { emptyProject, removeTempDirs, tempDir, updateProject } from './helpers.js';

afterEach(removeTempDirs);

const INSOMNIA = resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'fixtures', 'insomnia', 'crafted');

/** A v5 export whose base environment holds a vault secret: a project property that is a secret. */
const WITH_VAULT = `type: collection.insomnia.rest/5.0
name: Mini
meta:
  id: wrk_mini
collection:
  - name: Ping
    meta:
      id: req_ping
      sortKey: -1
    url: https://example.com/ping
    method: GET
environments:
  name: Base Environment
  meta:
    id: env_mini
  data:
    host: example.com
    __insomnia_vault:
      token: "••••"
`;

describe('op import: an Insomnia export', () => {
  it('adds its APIs, and its plain base variables as project properties', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: join(INSOMNIA, 'v4.json') }, fixture.base());

    expect(result.format).toBe('insomnia');
    expect(result.added.map((item) => item.kind)).toEqual(['rest', 'grpc', 'websocket']);
    const { project } = await loadProject(fixture.dir);
    expect(restApisOf(project)).toHaveLength(1);
    expect(grpcApisOf(project)).toHaveLength(1);
    expect(wsApisOf(project)).toHaveLength(1);
    expect(project.properties).toMatchObject({ baseUrl: 'https://api.example.com', 'db.host': 'localhost' });
  });

  it('reports environments, scripts and .proto files as not imported', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: join(INSOMNIA, 'v4.json') }, fixture.base());
    const codes = result.problems.map((problem) => problem.code);
    expect(codes).toContain('environments-not-imported');
    expect(codes).toContain('scripts-not-saved');
    expect(codes).toContain('definition-not-imported');
  });

  it('leaves secrets out and names them', async () => {
    const fixture = await emptyProject();
    const file = join(await tempDir(), 'mini.yaml');
    await writeFile(file, WITH_VAULT);
    const result = await runOp(importOp, { source: file }, fixture.base());

    const secret = result.problems.find((problem) => problem.code === 'secret-not-imported');
    expect(secret?.message).toContain('token');
    const { project } = await loadProject(fixture.dir);
    expect(project.properties).toEqual({ host: 'example.com' });
  });

  it('keeps an existing property value', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({ ...project, properties: { baseUrl: 'http://localhost' } }));
    const result = await runOp(importOp, { source: join(INSOMNIA, 'v5-collection.yaml') }, fixture.base());

    expect(result.problems.find((problem) => problem.code === 'property-kept')?.message).toContain('baseUrl');
    const { project } = await loadProject(fixture.dir);
    expect(project.properties['baseUrl']).toBe('http://localhost');
  });

  it('refuses an environments file, before writing anything', async () => {
    const fixture = await emptyProject();
    await expect(
      runOp(importOp, { source: join(INSOMNIA, 'v5-environment.yaml') }, fixture.base()),
    ).rejects.toMatchObject({ code: 'environments-not-imported' });
    const { project } = await loadProject(fixture.dir);
    expect(restApisOf(project)).toEqual([]);
  });

  it('passes the variable report through: a credential in a URL and credential-looking names', async () => {
    const fixture = await emptyProject();
    const file = join(await tempDir(), 'vars.yaml');
    await writeFile(
      file,
      WITH_VAULT.replace('    host: example.com\n', '    host: https://user:LEAKPW@example.com\n    apiToken: plain\n'),
    );
    const result = await runOp(importOp, { source: file }, fixture.base());

    const messages = result.problems.map((problem) => problem.message);
    expect(messages.some((m) => m.includes('the credential in the URL of "host" was not imported'))).toBe(true);
    expect(messages.some((m) => m.includes('apiToken'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('LEAKPW');
  });
});

describe('op import: vault secrets', () => {
  it('names a vault secret once, under secret-not-imported', async () => {
    const fixture = await emptyProject();
    const file = join(await tempDir(), 'mini.yaml');
    await writeFile(file, WITH_VAULT);
    const result = await runOp(importOp, { source: file }, fixture.base());

    const naming = result.problems.filter((problem) => problem.message.includes('token'));
    expect(naming.map((problem) => problem.code)).toEqual(['secret-not-imported']);
  });
});

describe('op import: environment files', () => {
  it('refuses a Postman environment with environments-not-imported, before writing anything', async () => {
    const fixture = await emptyProject();
    const file = join(await tempDir(), 'staging.postman_environment.json');
    await writeFile(
      file,
      JSON.stringify({
        id: 'e1',
        name: 'Staging',
        values: [{ key: 'baseUrl', value: 'https://staging.example.com', enabled: true }],
        _postman_variable_scope: 'environment',
      }),
    );
    await expect(runOp(importOp, { source: file }, fixture.base())).rejects.toMatchObject({
      code: 'environments-not-imported',
    });
    const { project } = await loadProject(fixture.dir);
    expect(restApisOf(project)).toEqual([]);
  });
});

const BRUNO = resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'fixtures', 'bruno', 'crafted');

describe('op import: a Bruno collection', () => {
  it('imports a Bruno folder with environments, secrets and scripts left out and named', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: join(BRUNO, 'basic') }, fixture.base());

    expect(result.format).toBe('bruno');
    expect(result.added.map((item) => item.kind)).toEqual(['rest', 'grpc', 'websocket']);
    const codes = result.problems.map((problem) => problem.code);
    expect(codes).toContain('environments-not-imported');
    expect(codes).toContain('scripts-not-saved');
    expect(JSON.stringify(result)).not.toContain('proxy-pass-123');
    expect(JSON.stringify(result)).not.toContain('literal-digest-pass');
    const { project } = await loadProject(fixture.dir);
    expect(restApisOf(project)[0]?.name).toBe('demo-collection');
    expect(project.properties).toMatchObject({ tenant: 'acme' });
    expect(project.disabledProperties).toContain('legacy');
  });

  it('reads a bruno.json as its folder, and any other file as a JSON export', async () => {
    const fixture = await emptyProject();
    const viaJson = await runOp(importOp, { source: join(BRUNO, 'basic', 'bruno.json') }, fixture.base());
    expect(viaJson.added.map((item) => item.kind)).toEqual(['rest', 'grpc', 'websocket']);
    const exported = await runOp(importOp, { source: join(BRUNO, 'export.json'), name: 'Exported' }, fixture.base());
    expect(exported.format).toBe('bruno');
    expect(exported.added).toEqual([expect.objectContaining({ kind: 'rest', name: 'Exported' })]);
  });
});

const HOPPSCOTCH = resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'fixtures', 'hoppscotch', 'crafted');

describe('op import: a Hoppscotch collection', () => {
  it('imports a Hoppscotch collection, its plain variables as project properties and its secret left out', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: join(HOPPSCOTCH, 'v12-r17.json') }, fixture.base());

    expect(result.format).toBe('hoppscotch');
    expect(result.added).toEqual([expect.objectContaining({ kind: 'rest', name: 'Shop API', requests: 9 })]);
    const codes = result.problems.map((problem) => problem.code);
    expect(codes).toContain('secret-not-imported');
    expect(codes).toContain('scripts-not-saved');
    const { project } = await loadProject(fixture.dir);
    expect(project.properties).toMatchObject({ baseUrl: 'https://api.example.test', region: 'eu' });
    expect(project.properties).not.toHaveProperty('apiKey');
  });

  it('refuses an environments file', async () => {
    const fixture = await emptyProject();
    await expect(
      runOp(importOp, { source: join(HOPPSCOTCH, 'environments-v2.json') }, fixture.base()),
    ).rejects.toMatchObject({ code: 'environments-not-imported' });
  });
});
