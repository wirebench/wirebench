import { rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_LOCAL_STATE, loadLocalState, saveLocalState } from '../../../src/workspace/local-state.js';
import { tempWorkspaceDir } from './fixture.js';

describe('local.yaml', () => {
  it('round-trips an active environment id', async () => {
    const dir = await tempWorkspaceDir();
    await saveLocalState(dir, { version: 1, activeEnvironmentId: 'ENV1' });

    expect(await loadLocalState(dir)).toEqual({ version: 1, activeEnvironmentId: 'ENV1' });

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

  it('reads as EMPTY_LOCAL_STATE when the file fails schema validation', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(join(dir, 'local.yaml'), 'version: 2\n');

    expect(await loadLocalState(dir)).toEqual(EMPTY_LOCAL_STATE);

    await rm(dir, { recursive: true, force: true });
  });

  it('deletes the file when saving EMPTY_LOCAL_STATE', async () => {
    const dir = await tempWorkspaceDir();
    await saveLocalState(dir, { version: 1, activeEnvironmentId: 'ENV1' });
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
