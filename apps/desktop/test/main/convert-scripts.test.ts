// @vitest-environment node
/**
 * Converting imported scripts in main (convert-imported-scripts spec §4.2, §7): the review's
 * proposals come from the model main holds, with TODO counts and the checker's problems; Accept
 * sends fingerprints only, and main writes the backups, each at its exact path, before it saves.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi, createFolder, createRestRequest, isWirebenchError, restApisOf } from '@wirebench/engine';
import type { Project, RequestScripts } from '@wirebench/engine';
import { conversionWire } from '../../src/main/convert-scripts.js';
import { EngineService } from '../../src/main/engine-service.js';
import { ProjectHost } from '../../src/main/project-host.js';
import { ScriptHost } from '../../src/main/script-host.js';

const PRE = 'pm.environment.set("token", "abc");\npm.sendRequest("http://x.test");\nnotDeclared();\n';

const LAYERED: RequestScripts = {
  pre: { text: PRE },
  api: 'postman',
  enabled: false,
  secrets: [],
};

const made: string[] = [];
const hosts: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A saved project holding one REST API with a layered request and a folder without scripts. */
async function openProject(): Promise<{ host: ProjectHost; dir: string; parent: string }> {
  const parent = mkdtempSync(join(tmpdir(), 'wirebench-convert-'));
  made.push(parent);
  const dir = join(parent, 'Demo');
  const host = new ProjectHost(new EngineService(), {});
  hosts.push(host);
  await host.create({ dir, name: 'Demo' });
  host.applyModelUpdate((project: Project) => ({
    ...project,
    containers: {
      ...project.containers,
      rest: [
        createApi('Shop', {
          id: 'api-1',
          baseUrl: 'http://shop.test',
          order: 0,
          requests: [{ ...createRestRequest('Login', { id: 'rest-1', order: 0 }), scripts: LAYERED }],
          folders: [createFolder('Carts', { id: 'f-1', order: 0 })],
        }),
      ],
    },
  }));
  await host.save({ reason: 'test' });
  return { host, dir, parent };
}

function scriptsOf(host: ProjectHost): RequestScripts | undefined {
  return restApisOf(host.model()!)[0]?.requests[0]?.scripts;
}

/** Every file under `dir`, relative, with `/` separators. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .split('\\')
        .join('/'),
    )
    .sort();
}

describe('proposing conversions', () => {
  it('propose returns levels with diffs, TODO counts and type-check problems', { timeout: 60_000 }, async () => {
    const { host } = await openProject();
    const scripts = new ScriptHost({
      modelOf: () => host.model(),
      openApiDocumentFor: () => Promise.reject(new Error('no definition')),
      grpcProtoSetFor: () => Promise.reject(new Error('no definition')),
      soapDefinitionFor: () => undefined,
    });
    hosts.push({ close: () => scripts.dispose() });

    const { project, levels } = await host.proposeConversions();
    expect(levels.map((level) => level.ownerId)).toEqual(['rest-1']);
    const wire = await conversionWire(project, levels[0]!, scripts.convertedDiagnostics.bind(scripts));

    expect(wire).toMatchObject({
      ownerId: 'rest-1',
      path: ['Shop', 'Login'],
      dialect: 'postman',
      before: { pre: PRE },
      backups: ['imported-scripts/shop/shop-login.pre.js'],
      fingerprint: levels[0]!.fingerprint,
    });
    if (!wire.result.ok) throw new Error(`did not convert: ${wire.result.message}`);
    expect(wire.result.pre).toContain('// Converted from a postman script; the original is in imported-scripts/');
    expect(wire.result.pre).not.toContain('pm.environment');
    expect(wire.result.todoCounts).toEqual({ unsupported: 1, notMapped: 0, shadowed: 0 });
    expect(wire.result.todos.map((todo) => [todo.phase, todo.call, todo.kind])).toEqual([
      ['pre', 'pm.sendRequest', 'unsupported'],
    ]);
    // The checker sees the converted text as typed: only the name nothing declares is a problem.
    const problems = wire.result.problems.pre ?? [];
    expect(problems.map((problem) => problem.message)).toEqual([expect.stringContaining('notDeclared')]);
    expect(wire.result.problems.post).toBeUndefined();

    // A root that names nothing proposes nothing; the folder has no scripts.
    expect((await host.proposeConversions('f-1')).levels).toEqual([]);
  });
});

describe('accepting conversions', () => {
  it('apply writes the backups first, then switches and saves', async () => {
    const { host, dir } = await openProject();
    const { levels } = await host.proposeConversions();
    const backup = join(dir, 'imported-scripts', 'shop', 'shop-login.pre.js');
    const save = vi.spyOn(host, 'save');
    const backupBeforeSave: boolean[] = [];
    save.mockImplementation(async function (this: ProjectHost, options) {
      backupBeforeSave.push(existsSync(backup));
      save.mockRestore();
      return await host.save(options);
    });

    const result = await host.mutate({
      kind: 'convert-scripts',
      levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }],
    });

    expect(backupBeforeSave).toEqual([true]);
    expect(await readFile(backup, 'utf8')).toBe(PRE);
    expect(result.converted).toEqual({
      applied: [
        { ownerId: 'rest-1', path: ['Shop', 'Login'], backups: ['imported-scripts/shop/shop-login.pre.js'], todos: 1 },
      ],
      refused: [],
    });
    const after = scriptsOf(host);
    expect(after?.api).toBe('wirebench');
    // Kept as it was: convert never switches scripts on.
    expect(after?.enabled).toBe(false);
    // Saved: the typed file is written and the layered one removed as stale.
    const files = filesUnder(dir);
    expect(files.some((file) => file.endsWith('.pre.ts'))).toBe(true);
    expect(files.filter((file) => file.endsWith('.pre.js'))).toEqual(['imported-scripts/shop/shop-login.pre.js']);
    expect(host.snapshot()?.dirty).toBe(false);
  });

  it('a changed fingerprint is refused by name', async () => {
    const { host, dir } = await openProject();
    const { levels } = await host.proposeConversions();
    // The Scripts tab's edit reaches main after the review opened.
    await host.mutate({ kind: 'update-request-scripts', requestId: 'rest-1', scripts: { pre: 'pm.test("x");' } });
    await host.save({ reason: 'test' });

    const result = await host.mutate({
      kind: 'convert-scripts',
      levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }],
    });

    expect(result.converted).toEqual({
      applied: [],
      refused: [{ ownerId: 'rest-1', path: ['Shop', 'Login'], reason: 'changed' }],
    });
    expect(scriptsOf(host)?.api).toBe('postman');
    expect(existsSync(join(dir, 'imported-scripts'))).toBe(false);
  });

  it('a backup path outside imported-scripts is refused', async () => {
    const { host, dir, parent } = await openProject();
    const { levels } = await host.proposeConversions();
    // The API's backup folder links out of the project: the backup would land outside it.
    const outside = join(parent, 'outside');
    mkdirSync(outside);
    mkdirSync(join(dir, 'imported-scripts'));
    symlinkSync(outside, join(dir, 'imported-scripts', 'shop'), 'dir');
    const before = filesUnder(dir);

    const error = await host
      .mutate({ kind: 'convert-scripts', levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }] })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(isWirebenchError(error) && error.code).toBe('import-path-refused');
    expect(readdirSync(outside)).toEqual([]);
    // Nothing switched and nothing saved: the layered file is still there.
    expect(scriptsOf(host)?.api).toBe('postman');
    expect(filesUnder(dir)).toEqual(before);
    await expect(
      host.writeImportedScripts([{ path: 'imported-scripts/../escape.js', source: 'x' }], { strict: true }),
    ).rejects.toMatchObject({ code: 'import-path-refused' });
    expect(existsSync(join(dir, 'escape.js'))).toBe(false);
  });

  it('a project with unsaved edits is refused before any backup is written', async () => {
    const { host, dir } = await openProject();
    const { levels } = await host.proposeConversions();
    await host.mutate({ kind: 'update-rest-request', requestId: 'rest-1', patch: { url: '/elsewhere' } });
    const before = filesUnder(dir);
    const model = host.model();

    await expect(
      host.mutate({ kind: 'convert-scripts', levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }] }),
    ).rejects.toMatchObject({ code: 'project-dirty' });

    expect(host.model()).toBe(model);
    expect(scriptsOf(host)?.api).toBe('postman');
    expect(filesUnder(dir)).toEqual(before);
    expect(existsSync(join(dir, 'imported-scripts'))).toBe(false);
  });

  it('a layered file edited outside Wirebench is refused before any backup is written', async () => {
    const { host, dir } = await openProject();
    const { levels } = await host.proposeConversions();
    const layered = filesUnder(dir).filter((file) => file.endsWith('.pre.js'));
    expect(layered).toHaveLength(1);
    // Edited in another editor while the project is open: the model still holds the old text.
    const outsideEdit = 'pm.environment.set("token", "edited outside");\n';
    writeFileSync(join(dir, layered[0]!), outsideEdit);
    const model = host.model();

    await expect(
      host.mutate({ kind: 'convert-scripts', levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }] }),
    ).rejects.toMatchObject({
      code: 'project-changed-on-disk',
      message: 'A script file changed outside Wirebench. Reload the project, then convert.',
    });

    expect(await readFile(join(dir, layered[0]!), 'utf8')).toBe(outsideEdit);
    expect(existsSync(join(dir, 'imported-scripts'))).toBe(false);
    expect(host.model()).toBe(model);
    expect(scriptsOf(host)?.api).toBe('postman');
    expect(filesUnder(dir).some((file) => file.endsWith('.pre.ts'))).toBe(false);
  });

  it('a layered file deleted outside Wirebench is refused too', async () => {
    const { host, dir } = await openProject();
    const { levels } = await host.proposeConversions();
    const layered = filesUnder(dir).filter((file) => file.endsWith('.pre.js'));
    rmSync(join(dir, layered[0]!));

    await expect(
      host.mutate({ kind: 'convert-scripts', levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }] }),
    ).rejects.toMatchObject({ code: 'project-changed-on-disk' });

    expect(existsSync(join(dir, 'imported-scripts'))).toBe(false);
    expect(scriptsOf(host)?.api).toBe('postman');
  });

  it('a level refused as not layered keeps its path; a gone one has none', async () => {
    const { host } = await openProject();

    const result = await host.mutate({
      kind: 'convert-scripts',
      levels: [
        { ownerId: 'f-1', fingerprint: 'x' },
        { ownerId: 'gone', fingerprint: 'x' },
      ],
    });

    expect(result.converted?.refused).toEqual([
      { ownerId: 'f-1', path: ['Shop', 'Carts'], reason: 'not-layered' },
      { ownerId: 'gone', path: [], reason: 'not-layered' },
    ]);
  });
});

describe('accepting conversions while something else happens', () => {
  /** Runs `meanwhile` once the backups are written, before the host switches the model. */
  function duringBackups(host: ProjectHost, meanwhile: () => Promise<unknown>): void {
    const original = host.writeImportedScripts.bind(host);
    vi.spyOn(host, 'writeImportedScripts').mockImplementation(async (scripts, options) => {
      const written = await original(scripts, options);
      await meanwhile();
      return written;
    });
  }

  it('an edit that lands while the backups are written is kept, and the conversion refused', async () => {
    const { host, dir } = await openProject();
    const { levels } = await host.proposeConversions();
    duringBackups(host, () =>
      host.mutate({ kind: 'update-rest-request', requestId: 'rest-1', patch: { name: 'Sign in' } }),
    );

    await expect(
      host.mutate({ kind: 'convert-scripts', levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }] }),
    ).rejects.toMatchObject({ code: 'project-changed' });

    expect(scriptsOf(host)?.api).toBe('postman');
    expect(restApisOf(host.model()!)[0]?.requests[0]?.name).toBe('Sign in');
    expect(
      filesUnder(dir).filter((file) => file.endsWith('.pre.js') && !file.startsWith('imported-scripts/')),
    ).toHaveLength(1);
    expect(filesUnder(dir).some((file) => file.endsWith('.pre.ts'))).toBe(false);
  });

  it('a project reopened while the backups are written is not switched', async () => {
    const { host, dir } = await openProject();
    const { levels } = await host.proposeConversions();
    duringBackups(host, () => host.reload());

    await expect(
      host.mutate({ kind: 'convert-scripts', levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }] }),
    ).rejects.toMatchObject({ code: 'project-changed' });

    expect(scriptsOf(host)?.api).toBe('postman');
    expect(host.snapshot()?.dirty).toBe(false);
    expect(filesUnder(dir).some((file) => file.endsWith('.pre.ts'))).toBe(false);
  });

  it('a backup file created between the listing and the write is never overwritten', async () => {
    const { host, dir } = await openProject();
    const { levels } = await host.proposeConversions();
    const backup = join(dir, 'imported-scripts', 'shop', 'shop-login.pre.js');
    const original = host.writeImportedScripts.bind(host);
    vi.spyOn(host, 'writeImportedScripts').mockImplementation(async (scripts, options) => {
      mkdirSync(join(dir, 'imported-scripts', 'shop'), { recursive: true });
      writeFileSync(backup, 'planted');
      return await original(scripts, options);
    });

    await expect(
      host.mutate({ kind: 'convert-scripts', levels: [{ ownerId: 'rest-1', fingerprint: levels[0]!.fingerprint }] }),
    ).rejects.toMatchObject({ code: 'backup-exists' });

    expect(await readFile(backup, 'utf8')).toBe('planted');
    expect(filesUnder(dir).filter((file) => file.startsWith('imported-scripts/'))).toEqual([
      'imported-scripts/shop/shop-login.pre.js',
    ]);
    expect(scriptsOf(host)?.api).toBe('postman');
    expect(host.snapshot()?.dirty).toBe(false);
    expect(filesUnder(dir).some((file) => file.endsWith('.pre.ts'))).toBe(false);
  });
});
