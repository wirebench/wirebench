import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../../src/errors.js';
import { loadWorkspace } from '../../../src/workspace/load.js';
import { saveWorkspace } from '../../../src/workspace/save.js';
import { workspaceFiles } from '../../../src/workspace/serialize.js';
import type { Workspace } from '../../../src/workspace/model.js';
import { listTree, readBytes, sampleWorkspace, tempWorkspaceDir } from './fixture.js';

/** Drops `keys` from `value`, exercising the optional-field-omitted case without an unused destructured binding. */
function withoutFields<T extends object, K extends keyof T>(value: T, ...keys: readonly K[]): Omit<T, K> {
  const clone = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    delete clone[key as string];
  }
  return clone as Omit<T, K>;
}

describe('saveWorkspace', () => {
  it('writes the documented folder layout', async () => {
    const dir = await tempWorkspaceDir();
    const result = await saveWorkspace(sampleWorkspace(), dir);

    expect(await listTree(dir)).toEqual(['environments/dev.yaml', 'environments/prod.yaml', 'workspace.yaml']);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.written).toHaveLength(3);
    expect(result.backups).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('emits YAML with stable, sorted key order and no line wrapping', async () => {
    const dir = await tempWorkspaceDir();
    await saveWorkspace(sampleWorkspace(), dir);

    expect((await readBytes(dir, 'workspace.yaml')).toString('utf8')).toMatchInlineSnapshot(`
      "createdAt: 2026-01-01T00:00:00.000Z
      description: Round-trip fixture
      disabled:
        - tier
      formatVersion: 3
      id: ID0005
      name: Demo Workspace
      projects:
        - id: ID0001
          slug: CountryInfo
          source: internal
        - id: ID0002
          path: /srv/wirebench-projects/orders
          slug: Orders
          source: linked
      properties:
        region: eu-west-1
        tier: gold
      "
    `);
    expect((await readBytes(dir, 'environments/dev.yaml')).toString('utf8')).toMatchInlineSnapshot(`
      "disabled:
        - region
      endpoints:
        CountryInfo/CountryInfoSoap: http://localhost:8080/country
      id: ID0003
      name: dev
      order: 0
      properties:
        region: local
      "
    `);

    await rm(dir, { recursive: true, force: true });
  });

  it('leaves a re-save of an unchanged workspace entirely untouched', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);

    const again = await saveWorkspace(workspace, dir);
    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.unchanged).toHaveLength(3);

    await rm(dir, { recursive: true, force: true });
  });

  it('renaming one environment changes exactly one file and removes the old one', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    const previous = workspaceFiles(workspace);
    await saveWorkspace(workspace, dir);

    const renamed: Workspace = {
      ...workspace,
      environments: workspace.environments.map((e) =>
        e.slug === 'dev' ? { ...e, name: 'develop', slug: 'develop' } : e,
      ),
    };
    const result = await saveWorkspace(renamed, dir, { previous });

    expect(result.written).toEqual(['environments/develop.yaml']);
    expect(result.removed).toEqual(['environments/dev.yaml']);
    expect(result.unchanged).toHaveLength(2);

    await rm(dir, { recursive: true, force: true });
  });

  it('removes the environments directory once its last environment is deleted', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);

    const result = await saveWorkspace({ ...workspace, environments: [] }, dir);

    expect(result.removed).toEqual(['environments', 'environments/dev.yaml', 'environments/prod.yaml']);
    expect(await listTree(dir)).toEqual(['workspace.yaml']);

    await rm(dir, { recursive: true, force: true });
  });

  it('leaves foreign files inside managed directories untouched by a save', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);

    await writeFile(join(dir, 'environments', 'notes.txt'), 'ignored');
    await writeFile(join(dir, 'README.md'), '# notes');

    const result = await saveWorkspace(workspace, dir);

    expect(result.removed).toEqual([]);
    const tree = await listTree(dir);
    expect(tree).toContain('environments/notes.txt');
    expect(tree).toContain('README.md');

    await rm(dir, { recursive: true, force: true });
  });

  it('rejects an environment slug that would escape the workspace root, before touching disk', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();

    for (const badSlug of ['..', '../x', 'a/b', '.']) {
      const corrupted: Workspace = {
        ...workspace,
        environments: [{ ...workspace.environments[0]!, slug: badSlug }],
      };
      await expect(saveWorkspace(corrupted, dir)).rejects.toMatchObject({ code: 'workspace-path-invalid' });
    }
    expect(await listTree(dir)).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('omits activeEnvironmentId and description entirely when unset', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = withoutFields(sampleWorkspace(), 'activeEnvironmentId', 'description');
    await saveWorkspace(workspace, dir);

    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    expect(text).not.toContain('activeEnvironmentId');
    expect(text).not.toContain('description');

    await rm(dir, { recursive: true, force: true });
  });

  it('writes disabled sorted, deduplicated, and dropped once its list would be empty', async () => {
    const dir = await tempWorkspaceDir();
    const workspace: Workspace = {
      ...sampleWorkspace(),
      properties: { b: '2', a: '1' },
      disabledProperties: ['b', 'a', 'b', 'ghost'],
    };
    await saveWorkspace(workspace, dir);

    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    expect(text).toContain('disabled:\n  - a\n  - b\n');
    expect(text).not.toContain('ghost');

    await rm(dir, { recursive: true, force: true });
  });

  it('omits disabled entirely once every disabled name has been removed from properties', async () => {
    const dir = await tempWorkspaceDir();
    const workspace: Workspace = { ...sampleWorkspace(), properties: {}, disabledProperties: ['tier'] };
    await saveWorkspace(workspace, dir);

    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    expect(text).not.toContain('disabled');

    await rm(dir, { recursive: true, force: true });
  });
});

describe('loadWorkspace', () => {
  it('round-trips a workspace to a deep-equal model, activeEnvironmentId aside (it is never saved)', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);

    const { workspace: loaded, problems, legacy } = await loadWorkspace(dir);
    expect(problems).toEqual([]);
    expect(loaded).toEqual(withoutFields(workspace, 'activeEnvironmentId'));
    expect(loaded.activeEnvironmentId).toBeUndefined();
    expect(legacy).toEqual({});

    await rm(dir, { recursive: true, force: true });
  });

  it('survives a second save/load cycle without touching a file', async () => {
    const dir = await tempWorkspaceDir();
    await saveWorkspace(sampleWorkspace(), dir);
    const { workspace: loaded } = await loadWorkspace(dir);
    const again = await saveWorkspace(loaded, dir);
    expect(again.written).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('throws workspace-not-found when there is no manifest', async () => {
    const dir = await tempWorkspaceDir();
    await expect(loadWorkspace(dir)).rejects.toMatchObject({
      name: 'WorkspaceError',
      code: 'workspace-not-found',
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('throws workspace-not-found for a directory that does not exist at all', async () => {
    const dir = await tempWorkspaceDir();
    await rm(dir, { recursive: true, force: true });
    await expect(loadWorkspace(dir)).rejects.toMatchObject({ code: 'workspace-not-found' });
  });

  it('throws workspace-file-invalid with the file path for malformed yaml', async () => {
    const dir = await tempWorkspaceDir();
    await saveWorkspace(sampleWorkspace(), dir);
    await writeFile(join(dir, 'workspace.yaml'), 'formatVersion: [unclosed\n');

    const error = await loadWorkspace(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe('workspace-file-invalid');
    expect((error as WorkspaceError).details).toMatchObject({ file: 'workspace.yaml' });

    await rm(dir, { recursive: true, force: true });
  });

  it('throws workspace-file-invalid with the file path for a schema violation', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'workspace.yaml'), 'formatVersion: 1\nid: X\n');

    const error = (await loadWorkspace(dir).catch((e: unknown) => e)) as WorkspaceError;
    expect(error.code).toBe('workspace-file-invalid');
    expect(error.details).toMatchObject({ file: 'workspace.yaml' });
    expect((error.details as { issues: unknown[] }).issues.length).toBeGreaterThan(0);

    await rm(dir, { recursive: true, force: true });
  });

  it('throws workspace-format-too-new for a newer formatVersion', async () => {
    const dir = await tempWorkspaceDir();
    await saveWorkspace(sampleWorkspace(), dir);
    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    await writeFile(join(dir, 'workspace.yaml'), text.replace('formatVersion: 3', 'formatVersion: 4'));

    const error = (await loadWorkspace(dir).catch((e: unknown) => e)) as WorkspaceError;
    expect(error.code).toBe('workspace-format-too-new');
    expect(error.details).toMatchObject({ formatVersion: 4, supported: 3 });

    await rm(dir, { recursive: true, force: true });
  });

  it('throws workspace-file-invalid for a missing or invalid formatVersion', async () => {
    const dir = await tempWorkspaceDir();
    await saveWorkspace(sampleWorkspace(), dir);
    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    await writeFile(join(dir, 'workspace.yaml'), text.replace('formatVersion: 3', 'formatVersion: "1"'));

    const error = (await loadWorkspace(dir).catch((e: unknown) => e)) as WorkspaceError;
    expect(error.code).toBe('workspace-file-invalid');
    expect(JSON.stringify(error.details)).toContain('formatVersion');

    await rm(dir, { recursive: true, force: true });
  });

  it('ignores an unknown top-level key in a manifest written by a newer 1.x build', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);
    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    await writeFile(join(dir, 'workspace.yaml'), `${text}surprise: yes\n`);

    const { workspace: loaded } = await loadWorkspace(dir);
    expect(loaded).toEqual(withoutFields(workspace, 'activeEnvironmentId'));
    expect(Object.keys(loaded)).not.toContain('surprise');

    await rm(dir, { recursive: true, force: true });
  });

  it('reports a corrupt environment file as a problem and still loads the workspace', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);
    await writeFile(join(dir, 'environments', 'dev.yaml'), 'endpoints: [unclosed\n');

    const { workspace: loaded, problems } = await loadWorkspace(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('environment-file-invalid');
    expect(problems[0]?.file).toBe('environments/dev.yaml');
    expect(loaded.environments.map((e) => e.slug)).toEqual(['prod']);

    await rm(dir, { recursive: true, force: true });
  });

  it('reports an environment file that fails schema validation as a problem', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);
    await writeFile(join(dir, 'environments', 'prod.yaml'), 'name: prod\n');

    const { problems } = await loadWorkspace(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('environment-file-invalid');
    expect(problems[0]?.file).toBe('environments/prod.yaml');

    await rm(dir, { recursive: true, force: true });
  });

  it('reports a malformed project reference as a problem and still loads the workspace', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);
    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    await writeFile(join(dir, 'workspace.yaml'), text.replace('source: internal', 'source: bogus'));

    const { workspace: loaded, problems } = await loadWorkspace(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('project-ref-invalid');
    expect(problems[0]?.file).toBe('workspace.yaml');
    expect(loaded.projects.map((p) => p.slug)).toEqual(['Orders']);

    await rm(dir, { recursive: true, force: true });
  });

  it('reports a linked project reference with a relative path as invalid', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);
    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    await writeFile(join(dir, 'workspace.yaml'), text.replace('/srv/wirebench-projects/orders', 'relative/orders'));

    const { loaded, problems } = await loadWorkspace(dir).then((r) => ({ loaded: r.workspace, problems: r.problems }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('project-ref-invalid');
    expect(loaded.projects.map((p) => p.slug)).toEqual(['CountryInfo']);

    await rm(dir, { recursive: true, force: true });
  });

  it('never persists activeEnvironmentId, and always loads it as undefined', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = { ...sampleWorkspace(), activeEnvironmentId: 'GHOST' };
    await saveWorkspace(workspace, dir);

    const text = (await readBytes(dir, 'workspace.yaml')).toString('utf8');
    expect(text).not.toContain('activeEnvironmentId');

    const { workspace: loaded, legacy } = await loadWorkspace(dir);
    expect(loaded.activeEnvironmentId).toBeUndefined();
    expect(legacy).toEqual({});

    await rm(dir, { recursive: true, force: true });
  });

  it('loads a workspace with no environments directory at all', async () => {
    const dir = await tempWorkspaceDir();
    await saveWorkspace({ ...sampleWorkspace(), environments: [] }, dir);

    const { workspace: loaded } = await loadWorkspace(dir);
    expect(loaded.environments).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });

  it('ignores a foreign file inside the environments directory', async () => {
    const dir = await tempWorkspaceDir();
    const workspace = sampleWorkspace();
    await saveWorkspace(workspace, dir);
    await mkdir(join(dir, 'environments'), { recursive: true });
    await writeFile(join(dir, 'environments', 'notes.txt'), 'ignored');

    const { workspace: loaded, problems } = await loadWorkspace(dir);
    expect(problems).toEqual([]);
    expect(loaded.environments.map((e) => e.slug)).toEqual(['dev', 'prod']);

    await rm(dir, { recursive: true, force: true });
  });

  it('lifts a v2 activeEnvironmentId into legacy, and drops writtenBy, on load', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(
      join(dir, 'workspace.yaml'),
      [
        'formatVersion: 2',
        'id: W1',
        'name: Legacy',
        'createdAt: 2026-01-01T00:00:00.000Z',
        'properties: {}',
        'activeEnvironmentId: ID0003',
        'projects: []',
        'writtenBy: wirebench',
        '',
      ].join('\n'),
    );

    const { workspace: loaded, legacy } = await loadWorkspace(dir);
    expect(legacy).toEqual({ activeEnvironmentId: 'ID0003' });
    expect(loaded.activeEnvironmentId).toBeUndefined();
    expect(loaded.formatVersion).toBe(3);

    const files = workspaceFiles(loaded);
    const manifest = files.get('workspace.yaml') ?? '';
    expect(manifest).not.toContain('activeEnvironmentId');
    expect(manifest).not.toContain('writtenBy');
    expect(manifest.startsWith('createdAt:') || manifest.includes('formatVersion: 3')).toBe(true);
    expect(manifest).toContain('formatVersion: 3');

    await rm(dir, { recursive: true, force: true });
  });

  it('still parses a v3 manifest carrying a linked project ref (the share refusal is main’s job)', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(
      join(dir, 'workspace.yaml'),
      [
        'formatVersion: 3',
        'id: W1',
        'name: Shared',
        'createdAt: 2026-01-01T00:00:00.000Z',
        'properties: {}',
        'projects:',
        '  - id: P1',
        '    slug: demo',
        '    source: linked',
        '    path: /srv/demo',
        '',
      ].join('\n'),
    );

    const { workspace: loaded, problems } = await loadWorkspace(dir);
    expect(problems).toEqual([]);
    expect(loaded.projects).toEqual([{ id: 'P1', slug: 'demo', source: 'linked', path: '/srv/demo' }]);

    await rm(dir, { recursive: true, force: true });
  });
});
