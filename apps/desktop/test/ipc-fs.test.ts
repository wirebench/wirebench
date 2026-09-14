// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFsChannels } from '../src/main/ipc/fs.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

describe('fs.* IPC', () => {
  let dir: string;

  beforeEach(async () => {
    handlers.clear();
    dir = await mkdtemp(join(tmpdir(), 'wirebench-fs-test-'));
    registerFsChannels();
  });

  afterEach(async () => {
    delete process.env['WIREBENCH_E2E_SAVE_PATH'];
    delete process.env['WIREBENCH_E2E_OPEN_PATH'];
    await rm(dir, { recursive: true, force: true });
  });

  it('fs.saveText writes the text to the e2e override path', async () => {
    const target = join(dir, 'saved.xml');
    process.env['WIREBENCH_E2E_SAVE_PATH'] = target;

    const result = (await invoke('fs.saveText', { text: '<a/>' })) as { ok: true; value: { path?: string } };

    expect(result.ok).toBe(true);
    expect(result.value.path).toBe(target);
    expect(await readFile(target, 'utf-8')).toBe('<a/>');
  });

  it('fs.saveText writes atomically: the target appears whole and no temp file is left beside it', async () => {
    const target = join(dir, 'saved.xml');
    process.env['WIREBENCH_E2E_SAVE_PATH'] = target;

    await invoke('fs.saveText', { text: '<a/>' });

    // The write goes to a `<name>.tmp-<hex>` sibling that is renamed over the target, so a reader
    // that sees the target sees all of it; the sibling must be gone once the handler answers.
    const left = (await import('node:fs/promises').then((m) => m.readdir(dir))).filter((name) =>
      name.includes('.tmp-'),
    );
    expect(left).toEqual([]);
    expect(await readFile(target, 'utf-8')).toBe('<a/>');
  });

  it('fs.openText reads back the text from the e2e override path', async () => {
    const target = join(dir, 'loaded.xml');
    await import('node:fs/promises').then((m) => m.writeFile(target, '<b/>', 'utf-8'));
    process.env['WIREBENCH_E2E_OPEN_PATH'] = target;

    const result = (await invoke('fs.openText', {})) as { ok: true; value: { path?: string; text?: string } };

    expect(result.ok).toBe(true);
    expect(result.value.path).toBe(target);
    expect(result.value.text).toBe('<b/>');
  });

  it('fs.openText refuses a file over 20 MB', async () => {
    const target = join(dir, 'huge.xml');
    const big = Buffer.alloc(21 * 1024 * 1024, 'a');
    await import('node:fs/promises').then((m) => m.writeFile(target, big));
    process.env['WIREBENCH_E2E_OPEN_PATH'] = target;

    const result = await invoke('fs.openText', {});
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a malformed fs.saveText payload', async () => {
    const result = await invoke('fs.saveText', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });
});
