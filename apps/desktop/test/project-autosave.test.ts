// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences } from '@wirebench/engine';
import type { Preferences } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { AUTOSAVE_DEBOUNCE_MS, ProjectHost } from '../src/main/project-host.js';

let root: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'wirebench-autosave-'));
});

afterEach(() => {
  vi.useRealTimers();
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

/** A host whose only injected dependency is a preferences document the test controls. */
function hostWith(autosave: boolean | undefined) {
  let preferences: Preferences =
    autosave === undefined ? DEFAULT_PREFERENCES : mergePreferences({ editor: { autosave } });
  const host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, {
    get: () => preferences,
  });
  return {
    host,
    /** Flips the preference the way `preferences.update` does, without the IPC layer. */
    setAutosave: (next: boolean): void => {
      preferences = mergePreferences({ editor: { autosave: next } }, preferences);
    },
  };
}

/**
 * Runs the debounce out and waits for the write it triggers to finish. The timer is faked but
 * the disk is not, so advancing the clock only *starts* the save; each further turn of the loop
 * lets its real I/O settle. Bounded, so a save that never lands fails the assertion after it
 * rather than hanging the suite.
 */
async function waitForAutosave(host: ProjectHost): Promise<void> {
  for (let attempt = 0; attempt < 50 && host.snapshot()?.dirty !== false; attempt += 1) {
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
  }
}

/** The project's name as it currently stands on disk, which is what a save actually changes. */
async function nameOnDisk(dir: string): Promise<string> {
  const yaml = await readFile(join(dir, 'wirebench.yaml'), 'utf8');
  return /name:\s*(.+)/.exec(yaml)?.[1]?.trim() ?? '';
}

describe('autosave is opt-in', () => {
  it('is off in the shipped defaults', () => {
    expect(DEFAULT_PREFERENCES.editor.autosave).toBe(false);
  });

  it('leaves an edit unwritten, and dirty, when it is off', async () => {
    const dir = join(root!, 'Manual');
    const { host } = hostWith(false);
    await host.create({ dir, name: 'Manual' });

    await host.mutate({ kind: 'rename-project', name: 'Renamed' });
    expect(host.snapshot()?.dirty).toBe(true);

    // Well past the debounce: with autosave off there was never a timer to fire.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 10);

    expect(host.snapshot()?.dirty).toBe(true);
    expect(await nameOnDisk(dir)).toBe('Manual');
  });

  it('writes the edit out after the debounce when it is on', async () => {
    const dir = join(root!, 'Auto');
    const { host } = hostWith(true);
    await host.create({ dir, name: 'Auto' });

    await host.mutate({ kind: 'rename-project', name: 'Renamed' });
    expect(host.snapshot()?.dirty).toBe(true);

    await waitForAutosave(host);

    expect(host.snapshot()?.dirty).toBe(false);
    expect(await nameOnDisk(dir)).toBe('Renamed');
  });

  it('still saves on demand while it is off — the edit is held, never lost', async () => {
    const dir = join(root!, 'Explicit');
    const { host } = hostWith(false);
    await host.create({ dir, name: 'Explicit' });
    await host.mutate({ kind: 'rename-project', name: 'Renamed' });

    await host.save({ reason: 'test' });

    expect(host.snapshot()?.dirty).toBe(false);
    expect(await nameOnDisk(dir)).toBe('Renamed');
  });

  it('picks up an outstanding edit when autosave is switched on mid-session', async () => {
    const dir = join(root!, 'Switched');
    const { host, setAutosave } = hostWith(false);
    await host.create({ dir, name: 'Switched' });
    await host.mutate({ kind: 'rename-project', name: 'Renamed' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(await nameOnDisk(dir)).toBe('Switched');

    setAutosave(true);
    host.onAutosaveEnabled();
    await waitForAutosave(host);

    expect(host.snapshot()?.dirty).toBe(false);
    expect(await nameOnDisk(dir)).toBe('Renamed');
  });

  it('does nothing on that hook when there is no outstanding edit', async () => {
    const dir = join(root!, 'Clean');
    const { host, setAutosave } = hostWith(false);
    await host.create({ dir, name: 'Clean' });

    setAutosave(true);
    host.onAutosaveEnabled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(host.snapshot()?.dirty).toBe(false);
  });

  it('closing the project writes the held edit out, whatever the preference says', async () => {
    const dir = join(root!, 'Closing');
    const { host } = hostWith(false);
    await host.create({ dir, name: 'Closing' });
    await host.mutate({ kind: 'rename-project', name: 'Renamed' });

    await host.close();

    // Manual save chooses when routine edits land, not whether closing can discard them.
    expect(await nameOnDisk(dir)).toBe('Renamed');
  });
});
