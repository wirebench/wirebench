// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKSPACE_STATE_FILE } from '@wirebench/engine';
import { WorkspaceState } from '../src/main/workspace-state.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-wsstate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function stateFile(): string {
  return join(root, WORKSPACE_STATE_FILE);
}

describe('WorkspaceState', () => {
  it('reads as empty when the file does not exist', async () => {
    expect(await new WorkspaceState(root).read()).toEqual({ version: 1, lastOpenedAt: {} });
  });

  it('remembers the last opened workspace and stamps every one it has seen', async () => {
    const state = new WorkspaceState(root);
    await state.remember('ws-a', '2026-09-11T10:00:00.000Z');
    await state.remember('ws-b', '2026-09-11T11:00:00.000Z');

    expect(await state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: 'ws-b',
      lastOpenedAt: { 'ws-a': '2026-09-11T10:00:00.000Z', 'ws-b': '2026-09-11T11:00:00.000Z' },
    });
  });

  it('re-reads before each write, so two overlapping remembers keep both stamps', async () => {
    const state = new WorkspaceState(root);
    await Promise.all([
      state.remember('ws-a', '2026-09-11T10:00:00.000Z'),
      state.remember('ws-b', '2026-09-11T11:00:00.000Z'),
    ]);

    const stored = await state.read();
    expect(Object.keys(stored.lastOpenedAt).sort()).toEqual(['ws-a', 'ws-b']);
  });

  it('forgets a workspace, including its place as the last opened one', async () => {
    const state = new WorkspaceState(root);
    await state.remember('ws-a', '2026-09-11T10:00:00.000Z');
    await state.remember('ws-b', '2026-09-11T11:00:00.000Z');

    await state.forget('ws-b');

    const stored = await state.read();
    expect(stored.lastOpenedWorkspaceId).toBeUndefined();
    expect(stored.lastOpenedAt).toEqual({ 'ws-a': '2026-09-11T10:00:00.000Z' });
  });

  it('reads a corrupt or wrongly-shaped file as empty rather than throwing', async () => {
    const state = new WorkspaceState(root);
    await mkdir(root, { recursive: true });

    await writeFile(stateFile(), 'not json at all', 'utf8');
    expect(await state.read()).toEqual({ version: 1, lastOpenedAt: {} });

    await writeFile(stateFile(), JSON.stringify({ version: 99, lastOpenedWorkspaceId: 'x' }), 'utf8');
    expect(await state.read()).toEqual({ version: 1, lastOpenedAt: {} });
  });

  it('leaves no temp file behind after a write', async () => {
    const state = new WorkspaceState(root);
    await state.remember('ws-a', '2026-09-11T10:00:00.000Z');

    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(JSON.parse(await readFile(stateFile(), 'utf8'))).toMatchObject({ lastOpenedWorkspaceId: 'ws-a' });
  });

  it('renames a workspace: its stamp and its place as the last opened one move to the new id', async () => {
    const state = new WorkspaceState(root);
    await state.remember('ws-a', '2026-09-11T10:00:00.000Z');
    await state.remember('ws-b', '2026-09-11T11:00:00.000Z');

    await state.rename('ws-b', 'ws-c');

    expect(await state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: 'ws-c',
      lastOpenedAt: { 'ws-a': '2026-09-11T10:00:00.000Z', 'ws-c': '2026-09-11T11:00:00.000Z' },
    });
  });

  it('renaming an id it never saw changes nothing', async () => {
    const state = new WorkspaceState(root);
    await state.remember('ws-a', '2026-09-11T10:00:00.000Z');

    await state.rename('ws-x', 'ws-y');

    expect(await state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: 'ws-a',
      lastOpenedAt: { 'ws-a': '2026-09-11T10:00:00.000Z' },
    });
  });
});
