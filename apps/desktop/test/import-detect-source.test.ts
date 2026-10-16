// @vitest-environment node
/**
 * `api.detectImportSource`: what a picked file or folder is, read in main because the renderer never
 * holds a picked file's content. The path rule is the import rule: picked this session, or inside a
 * project folder.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

vi.mock('../src/main/native-dialogs.js', () => ({
  pickFolder: () => Promise.resolve(undefined),
  pickSaveFile: () => Promise.resolve(undefined),
  pickOpenFile: () => Promise.resolve(undefined),
}));

const { registerApiChannelsWithKinds } = await import('./helpers/kind-channels.js');
type ApiChannelDeps = Parameters<typeof registerApiChannelsWithKinds>[0];

type Envelope = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown };

const detect = (path: string, folder: boolean): Promise<Envelope> => {
  const handler = handlers.get('api.detectImportSource');
  if (handler === undefined) throw new Error('api.detectImportSource was never registered');
  return handler({ sender: { isDestroyed: () => false, send: vi.fn() } }, { path, folder }) as Promise<Envelope>;
};

describe('api.detectImportSource', () => {
  let dir = '';
  let picks = new DialogPicks();

  beforeEach(async () => {
    handlers.clear();
    dir = await realpath(await mkdtemp(join(tmpdir(), 'wirebench-detect-source-')));
    picks = new DialogPicks();
    registerApiChannelsWithKinds({ projectDirs: () => [], picks } as unknown as ApiChannelDeps);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a renamed export', async () => {
    const file = join(dir, 'export.json');
    await writeFile(file, 'type: collection.insomnia.rest/5.0\nname: x\n');
    picks.rememberRead(file);

    expect(await detect(file, false)).toEqual({
      ok: true,
      value: { kind: 'insomnia', label: 'Insomnia export', confidence: 'definite' },
    });
  });

  it('classifies a Bruno folder', async () => {
    const folder = join(dir, 'bruno-project');
    await mkdir(folder);
    await writeFile(join(folder, 'bruno.json'), '{}');
    await mkdir(join(folder, 'requests'));
    picks.rememberRead(folder);

    expect(await detect(folder, true)).toMatchObject({ ok: true, value: { kind: 'bruno', confidence: 'definite' } });
  });

  it('classifies a thunder-tests folder, and a folder holding collections/tc_col_*.json', async () => {
    const named = join(dir, 'thunder-tests');
    await mkdir(named);
    picks.rememberRead(named);
    expect(await detect(named, true)).toMatchObject({ ok: true, value: { kind: 'thunder-client' } });

    const workspace = join(dir, 'workspace');
    await mkdir(join(workspace, 'collections'), { recursive: true });
    await writeFile(join(workspace, 'collections', 'tc_col_abc.json'), '{}');
    picks.rememberRead(workspace);
    expect(await detect(workspace, true)).toMatchObject({ ok: true, value: { kind: 'thunder-client' } });

    const other = join(dir, 'other');
    await mkdir(join(other, 'collections'), { recursive: true });
    await writeFile(join(other, 'collections', 'notes.json'), '{}');
    picks.rememberRead(other);
    expect(await detect(other, true)).toMatchObject({
      ok: true,
      value: { kind: 'postman-v3', confidence: 'probable' },
    });
  });

  it('refuses an unpicked path', async () => {
    const file = join(dir, 'export.json');
    await writeFile(file, '{}');
    const folder = join(dir, 'f');
    await mkdir(folder);

    expect(await detect(file, false)).toMatchObject({ ok: false, error: { code: 'import-path-refused' } });
    expect(await detect(folder, true)).toMatchObject({ ok: false, error: { code: 'import-path-refused' } });
  });
});
