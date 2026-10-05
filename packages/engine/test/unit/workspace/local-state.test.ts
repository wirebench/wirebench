import { rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_LOCAL_STATE, loadLocalState, saveLocalState } from '../../../src/workspace/local-state.js';
import { tempWorkspaceDir } from './fixture.js';

describe('local.yaml', () => {
  it('round-trips an active environment id', async () => {
    const dir = await tempWorkspaceDir();
    await saveLocalState(dir, { version: 2, activeEnvironmentId: 'ENV1' });

    expect(await loadLocalState(dir)).toEqual({ version: 2, activeEnvironmentId: 'ENV1' });

    await rm(dir, { recursive: true, force: true });
  });

  it('reads as EMPTY_LOCAL_STATE when the file does not exist', async () => {
    const dir = await tempWorkspaceDir();
    expect(await loadLocalState(dir)).toEqual(EMPTY_LOCAL_STATE);
    await rm(dir, { recursive: true, force: true });
  });

  it('reads as EMPTY_LOCAL_STATE when the file is corrupt YAML', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'local.yaml'), 'version: [unclosed\n');

    expect(await loadLocalState(dir)).toEqual(EMPTY_LOCAL_STATE);

    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips version 2 with overrides and an approval', async () => {
    const dir = await tempWorkspaceDir();
    const state = {
      version: 2 as const,
      activeEnvironmentId: 'ENV1',
      secretSources: { a: { kind: 'none' as const } },
      secretSourcesApproved: { hash: 'ab'.repeat(32), mapping: { a: { kind: 'gcp', secret: 's' } } },
    };
    await saveLocalState(dir, state);
    expect(await loadLocalState(dir)).toEqual(state);
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a version-1 file as version 2', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'local.yaml'), 'version: 1\nactiveEnvironmentId: ENV1\n');
    expect(await loadLocalState(dir)).toEqual({ version: 2, activeEnvironmentId: 'ENV1' });
    await rm(dir, { recursive: true, force: true });
  });

  it('treats an unknown version as empty', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'local.yaml'), 'version: 3\n');
    expect(await loadLocalState(dir)).toEqual({ version: 2 });
    await rm(dir, { recursive: true, force: true });
  });

  it('deletes the file when saving EMPTY_LOCAL_STATE', async () => {
    const dir = await tempWorkspaceDir();
    await saveLocalState(dir, { version: 2, activeEnvironmentId: 'ENV1' });
    expect(existsSync(join(dir, 'local.yaml'))).toBe(true);

    await saveLocalState(dir, EMPTY_LOCAL_STATE);
    expect(existsSync(join(dir, 'local.yaml'))).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });

  it('deleting a local state that was never written is a no-op', async () => {
    const dir = await tempWorkspaceDir();
    await expect(saveLocalState(dir, EMPTY_LOCAL_STATE)).resolves.toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
