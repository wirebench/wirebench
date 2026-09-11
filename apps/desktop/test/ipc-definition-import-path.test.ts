// @vitest-environment node
/**
 * `definition.import { kind: 'file' }` is a file read at a renderer-named path, so it must
 * answer the same containment/dialog-pick question every other main-side read answers.
 *
 * Each refusal here is proved twice: the channel rejects with `import-path-refused`, *and*
 * `node:fs/promises`' `readFile` was never called for the path — a check that ran after the
 * read would still fail this suite.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import type { DefinitionChannelProject } from '../src/main/ipc/definition.js';
import { registerDefinitionChannels } from '../src/main/ipc/definition.js';
import { readPublicFixture } from './helpers/fixtures.js';

const { readFileSpy } = vi.hoisted(() => ({ readFileSpy: vi.fn<(path: unknown) => void>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    readFile: (path: unknown, ...rest: unknown[]) => {
      readFileSpy(path);
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(
  channel: string,
  payload: unknown,
): Promise<{ ok: boolean; value: unknown; error?: { code?: string } }> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, payload) as Promise<{
    ok: boolean;
    value: unknown;
    error?: { code?: string };
  }>;
}

/** True when the engine's file fetcher actually opened `path`. */
function didRead(path: string): boolean {
  return readFileSpy.mock.calls.flat().map(String).includes(path);
}

describe('definition.import — a file path must be proven, not merely named', () => {
  let dir: string;
  let projectDir: string;
  let outsidePath: string;
  let insidePath: string;
  let picks: DialogPicks;

  beforeEach(async () => {
    handlers.clear();
    readFileSpy.mockClear();
    dir = await mkdtemp(join(tmpdir(), 'wirebench-import-path-'));
    projectDir = join(dir, 'project');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectDir, { recursive: true });
    const wsdl = readPublicFixture('calculator');
    outsidePath = join(dir, 'outside.wsdl');
    insidePath = join(projectDir, 'inside.wsdl');
    await writeFile(outsidePath, wsdl, 'utf-8');
    await writeFile(insidePath, wsdl, 'utf-8');

    picks = new DialogPicks();
    const project = {} as unknown as DefinitionChannelProject;
    // Every open project's folder counts as "inside the project"; this workspace has one.
    registerDefinitionChannels(new EngineService(), { project, picks, projectDirs: () => [projectDir] });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses an absolute path the user never picked, before reading anything', async () => {
    const result = await invoke('definition.import', { source: { kind: 'file', path: outsidePath } });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('import-path-refused');
    expect(didRead(outsidePath)).toBe(false);
  });

  it('imports the very same path once it has been picked through the Browse… dialog', async () => {
    picks.rememberRead(outsidePath);

    const result = await invoke('definition.import', { source: { kind: 'file', path: outsidePath } });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(didRead(outsidePath)).toBe(true);
  });

  it('imports a path inside the open project folder without a pick', async () => {
    const result = await invoke('definition.import', { source: { kind: 'file', path: insidePath } });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
  });

  it('refuses a traversal out of the project folder, before reading anything', async () => {
    const traversal = join(projectDir, '..', 'outside.wsdl');

    const result = await invoke('definition.import', { source: { kind: 'file', path: traversal } });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('import-path-refused');
    expect(didRead(outsidePath)).toBe(false);
  });

  it('never refuses a text import — a dropped document carries its own bytes', async () => {
    const result = await invoke('definition.import', {
      source: { kind: 'text', text: readPublicFixture('calculator'), location: 'dropped:calculator.wsdl' },
    });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(didRead(outsidePath)).toBe(false);
  });
});
