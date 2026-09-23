// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences } from '@wirebench/engine';
import type { Preferences } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { AUTOSAVE_DEBOUNCE_MS, ProjectHost } from '../src/main/project-host.js';

let root: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-autosave-'));
});

afterEach(() => {
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
 * Real time, not fake: the debounce is a timer but the save it fires is disk I/O, and faking
 * only the clock leaves the write racing the assertion — which passed on one platform and
 * failed on another. Polling the state the feature actually reports removes the race.
 */
async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for an autosave to land, up to a budget many times the debounce it is waiting on. */
async function waitForAutosave(host: ProjectHost): Promise<void> {
  const deadline = Date.now() + AUTOSAVE_DEBOUNCE_MS * 20;
  while (host.snapshot()?.dirty !== false && Date.now() < deadline) {
    await delay(25);
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
    await delay(AUTOSAVE_DEBOUNCE_MS * 3);

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
    await delay(AUTOSAVE_DEBOUNCE_MS * 3);
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
    await delay(AUTOSAVE_DEBOUNCE_MS * 3);

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

/**
 * Secret scanning reviews a *manual* save only (the renderer asks before writing). The saves main
 * makes by itself — autosave, and the write on close — go ahead with a plain-text credential in
 * the project: the files are local, and nothing here is waiting on a person to answer.
 */
describe('the saves main makes by itself never wait for a secret review', () => {
  /** Obviously fake, under a name the scanner flags. */
  const FAKE_PASSWORD = 'fake-password-for-tests';

  it('autosave writes a project holding a possible secret', async () => {
    const dir = join(root!, 'AutoSecret');
    const { host } = hostWith(true);
    await host.create({ dir, name: 'AutoSecret' });

    await host.mutate({ kind: 'set-project-property', name: 'api_password', value: FAKE_PASSWORD });
    await waitForAutosave(host);

    expect(host.snapshot()?.dirty).toBe(false);
    expect(await readFile(join(dir, 'wirebench.yaml'), 'utf8')).toContain(FAKE_PASSWORD);
    await host.close();
  });

  it('a secret review holds autosave while it is open; after it settles autosave writes as usual', async () => {
    const dir = join(root!, 'HeldSecret');
    const { host } = hostWith(true);
    await host.create({ dir, name: 'HeldSecret' });
    // A manual save takes the hold, then commits the staged edit — which marks the project dirty.
    const release = host.holdAutosave();
    await host.mutate({ kind: 'set-project-property', name: 'api_password', value: FAKE_PASSWORD });

    // The dialog is open: well past the debounce, nothing has been written behind it.
    await delay(AUTOSAVE_DEBOUNCE_MS * 3);
    expect(host.snapshot()?.dirty).toBe(true);
    expect(await readFile(join(dir, 'wirebench.yaml'), 'utf8')).not.toContain(FAKE_PASSWORD);

    // Cancel: the edit stays in the model, the project stays dirty, and autosave — which writes
    // without asking (spec decision 8) — picks it up once the review is over.
    release();
    await waitForAutosave(host);
    expect(host.snapshot()?.dirty).toBe(false);
    expect(await readFile(join(dir, 'wirebench.yaml'), 'utf8')).toContain(FAKE_PASSWORD);
    await host.close();
  });

  it('a hold stops an autosave already scheduled, and only the last release resumes it', async () => {
    const dir = join(root!, 'HeldTwice');
    const { host } = hostWith(true);
    await host.create({ dir, name: 'HeldTwice' });
    await host.mutate({ kind: 'rename-project', name: 'Renamed' });
    const first = host.holdAutosave();
    const second = host.holdAutosave();

    first();
    first();
    await delay(AUTOSAVE_DEBOUNCE_MS * 3);
    expect(await nameOnDisk(dir)).toBe('HeldTwice');

    second();
    await waitForAutosave(host);
    expect(await nameOnDisk(dir)).toBe('Renamed');
    await host.close();
  });

  it('closing writes a held edit holding a possible secret', async () => {
    const dir = join(root!, 'CloseSecret');
    const { host } = hostWith(false);
    await host.create({ dir, name: 'CloseSecret' });
    await host.mutate({ kind: 'set-project-property', name: 'api_password', value: FAKE_PASSWORD });

    await host.close();

    expect(await readFile(join(dir, 'wirebench.yaml'), 'utf8')).toContain(FAKE_PASSWORD);
  });
});

describe('the project manifest does not record why it was saved', () => {
  it('a manual save followed by an autosave of the same model leaves wirebench.yaml byte-identical', async () => {
    const dir = join(root!, 'Stable');
    const { host } = hostWith(false);
    await host.create({ dir, name: 'Stable' });
    await host.mutate({ kind: 'rename-project', name: 'Renamed' });

    await host.save({ reason: 'manual' });
    const afterManual = await readFile(join(dir, 'wirebench.yaml'));
    const result = await host.save({ reason: 'autosave' });
    const afterAutosave = await readFile(join(dir, 'wirebench.yaml'));

    expect(afterAutosave.equals(afterManual)).toBe(true);
    expect(result.written).toBe(0);
    await host.close();
  });
});
