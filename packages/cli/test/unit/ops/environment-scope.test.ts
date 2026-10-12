import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { callOp } from '../../../src/ops/call.js';
import { runOp } from '../../../src/ops/context.js';
import { exitCodeForError } from '../../../src/ops/errors.js';
import type { OpsError } from '../../../src/ops/errors.js';
import { gateNamesInScope, pickEnvironment } from '../../../src/ops/environment.js';
import { deriveContractTools } from '../../../src/ops/contract-tools.js';
import { openProject } from '../../../src/ops/project.js';
import { enclosingWorkspace } from '../../../src/workspace-lookup.js';
import { ExitCode } from '../../../src/exit-codes.js';
import { removeTempDirs, soapProject, startServer, tempDir } from './helpers.js';
import type { Fixture } from './helpers.js';
import type { WorkspaceEnvironment } from '@wirebench/engine';

afterEach(removeTempDirs);

const env = (name: string, projects?: readonly string[]): WorkspaceEnvironment => ({
  id: `id-${name}`,
  name,
  slug: name.toLowerCase(),
  order: 0,
  endpoints: {},
  properties: {},
  disabledProperties: [],
  ...(projects !== undefined ? { projects } : {}),
});

function codeOf(call: () => unknown): string | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('pickEnvironment with a project id', () => {
  const all = [env('Dev'), env('QA', ['p1']), env('Prod', ['p2']), env('Frozen', [])];

  it('matches only the environments in scope', () => {
    expect(pickEnvironment(all, 'workspace', 'QA', 'p1')?.name).toBe('QA');
    expect(pickEnvironment(all, 'workspace', 'dev', 'p1')?.name).toBe('Dev');
  });

  it('fails out-of-scope (exit 2) for an environment of another project, by name, slug or id', () => {
    for (const wanted of ['Prod', 'prod', 'id-Prod']) {
      let error: OpsError | undefined;
      try {
        pickEnvironment(all, 'workspace', wanted, 'p1');
      } catch (caught) {
        error = caught as OpsError;
      }
      expect(error?.code).toBe('environment-out-of-scope');
      expect(error?.message).toContain('environments for it: Dev, QA');
      expect(error && exitCodeForError(error)).toBe(ExitCode.Usage);
    }
  });

  it('still says not-found for a name no environment has', () => {
    expect(codeOf(() => pickEnvironment(all, 'workspace', 'nope', 'p1'))).toBe('environment-not-found');
  });

  it('says no environment applies to the project, not that the workspace defines none, when none is in scope', () => {
    let error: OpsError | undefined;
    try {
      pickEnvironment([env('Prod', ['p2'])], 'workspace', 'nope', 'p1');
    } catch (caught) {
      error = caught as OpsError;
    }
    expect(error?.code).toBe('environment-not-found');
    expect(error?.message).toBe('unknown environment "nope": no environment applies to this project');
    expect(codeOf(() => pickEnvironment([], 'workspace', 'nope'))).toBe('environment-not-found');
  });

  it('requires one only while one is in scope', () => {
    expect(codeOf(() => pickEnvironment(all, 'workspace', undefined, 'p1'))).toBe('environment-required');
    const scoped = [env('Prod', ['p2'])];
    expect(pickEnvironment(scoped, 'workspace', undefined, 'p1')).toBeUndefined();
    expect(codeOf(() => pickEnvironment(scoped, 'workspace', 'Prod', 'p1'))).toBe('environment-out-of-scope');
  });

  it('leaves a project-owned pick (no project id) alone', () => {
    expect(pickEnvironment(all, 'project', 'Prod')?.name).toBe('Prod');
  });
});

/** A workspace holding a copy of `fixture` as its internal project `p1` (id `p1`), with the environment QA scoped to `projectsOfQa`. */
async function linkedWorkspace(fixture: Fixture, projectsOfQa: readonly string[]) {
  const root = await tempDir('wirebench-ws-');
  const dir = join(root, 'projects', 'p1');
  await cp(fixture.dir, dir, { recursive: true });
  await mkdir(join(root, 'environments'));
  await writeFile(
    join(root, 'workspace.yaml'),
    [
      'formatVersion: 3',
      'id: WS1',
      'name: Team',
      'createdAt: 2026-09-18T00:00:00.000Z',
      'properties: {}',
      'projects:',
      '  - id: p1',
      '    slug: p1',
      '    source: internal',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'environments', 'qa.yaml'),
    [
      'id: E1',
      'name: QA',
      'order: 0',
      `projects: [${projectsOfQa.join(', ')}]`,
      'endpoints: {}',
      'properties: {}',
      '',
    ].join('\n'),
  );
  const workspace = await enclosingWorkspace(dir, () => undefined);
  if (workspace === undefined) {
    throw new Error('the workspace was not found');
  }
  return { workspace, dir };
}

describe('gateNamesInScope', () => {
  it('drops the names that apply only to other projects', async () => {
    const fixture = await soapProject();
    const out = (await linkedWorkspace(fixture, ['p2'])).workspace;
    expect(gateNamesInScope(['QA', 'staging'], out)).toEqual(['staging']);
    const inside = (await linkedWorkspace(fixture, ['p1'])).workspace;
    expect(gateNamesInScope(['QA', 'staging'], inside)).toEqual(['QA', 'staging']);
    expect(gateNamesInScope(['QA'], undefined)).toEqual(['QA']);
  });

  it('shapes the tool descriptions', async () => {
    const fixture = await soapProject();
    const { dir } = await linkedWorkspace(fixture, ['p2']);
    const base = fixture.base({
      projectDir: dir,
      gates: { write: false, send: true, environments: ['QA', 'staging'] },
    });
    const { project, workspace } = await openProject(base);
    const set = await deriveContractTools(project, {
      projectDir: dir,
      gates: base.gates,
      ...(workspace !== undefined ? { workspace } : {}),
    });
    expect(set.tools[0]?.description).toContain('one of the environments staging.');
  });

  it('says no environment applies when every gate name is out of scope', async () => {
    const fixture = await soapProject();
    const { dir } = await linkedWorkspace(fixture, ['p2']);
    const base = fixture.base({ projectDir: dir, gates: { write: false, send: true, environments: ['QA'] } });
    const { project, workspace } = await openProject(base);
    const set = await deriveContractTools(project, {
      projectDir: dir,
      gates: base.gates,
      ...(workspace !== undefined ? { workspace } : {}),
    });
    const description = set.tools[0]?.description ?? '';
    expect(description).not.toContain('one of the environments');
    expect(description).toContain(
      'Needs --allow-send. No environment this server allows (--env) applies to this project.',
    );
    const environment = (set.tools[0]?.inputSchema as { properties: Record<string, { description?: string }> })
      .properties['environment'];
    expect(environment?.description).toBe(
      'The environment to send under, by name; required when any environment applies to the project',
    );
  });
});

describe('call inside a workspace', () => {
  it('refuses an out-of-scope environment without sending', async () => {
    const fixture = await soapProject();
    const server = await startServer(() => ({
      body:
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
        '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
        '</soapenv:Body></soapenv:Envelope>',
    }));
    try {
      const { dir } = await linkedWorkspace(fixture, ['p2']);
      const args = {
        tool: 'calculator_service_add',
        ref: 'CalculatorService/Add',
        args: { environment: 'QA', a: 1, b: 2 },
      };
      await expect(runOp(callOp, args, fixture.base({ projectDir: dir }))).rejects.toMatchObject({
        code: 'environment-out-of-scope',
      });
      expect(server.received).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
