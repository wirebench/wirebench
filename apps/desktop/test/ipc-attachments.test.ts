// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResponseAttachment } from '@wirebench/engine';
import {
  ATTACHMENTS_TMP_DIR,
  extensionForContentType,
  registerAttachmentChannels,
} from '../src/main/ipc/attachments.js';
import type { AttachmentChannelDeps } from '../src/main/ipc/attachments.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const showSaveDialog = vi.fn();
const showOpenDialog = vi.fn();
const openPath = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => undefined },
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args) as unknown,
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) as unknown,
  },
  shell: { openPath: (...args: unknown[]) => openPath(...args) as unknown },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const PART: ResponseAttachment = {
  contentId: 'part1@wirebench',
  contentType: 'image/png',
  size: BYTES.length,
  bytes: BYTES,
  name: 'logo.png',
};

/** The response part with no `name`, so the default file name has to come from its Content-ID. */
const UNNAMED: ResponseAttachment = {
  contentId: 'part2@wirebench',
  contentType: 'application/octet-stream',
  size: 1,
  bytes: new Uint8Array([7]),
};

describe('attachments.* IPC', () => {
  let dir: string;
  let resolveAttachmentPath: ReturnType<typeof vi.fn>;

  function register(userDataDir: string): void {
    resolveAttachmentPath = vi.fn();
    const deps: AttachmentChannelDeps = {
      exchanges: {
        getAttachment: (sendId, index) =>
          sendId !== 'send-1' ? undefined : ([PART, UNNAMED] as ResponseAttachment[])[index],
      },
      project: {
        resolveAttachmentPath: resolveAttachmentPath as AttachmentChannelDeps['project']['resolveAttachmentPath'],
      },
      userDataDir,
    };
    registerAttachmentChannels(deps);
  }

  beforeEach(async () => {
    handlers.clear();
    showSaveDialog.mockReset();
    showOpenDialog.mockReset();
    openPath.mockReset().mockResolvedValue('');
    dir = await mkdtemp(join(tmpdir(), 'wirebench-attachments-'));
    register(dir);
  });

  afterEach(async () => {
    delete process.env['WIREBENCH_E2E_SAVE_PATH'];
    delete process.env['WIREBENCH_E2E_OPEN_PATH'];
    await rm(dir, { recursive: true, force: true });
  });

  it('saveResponse writes the exact bytes to an explicit path', async () => {
    const target = join(dir, 'out.png');

    const result = (await invoke('attachments.saveResponse', {
      sendId: 'send-1',
      index: 0,
      path: target,
    })) as Envelope<{ path?: string }>;

    expect(result).toMatchObject({ ok: true, value: { path: target } });
    expect(new Uint8Array(await readFile(target))).toEqual(BYTES);
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('saveResponse honours the e2e save override instead of showing a dialog', async () => {
    const target = join(dir, 'e2e.png');
    process.env['WIREBENCH_E2E_SAVE_PATH'] = target;

    const result = (await invoke('attachments.saveResponse', { sendId: 'send-1', index: 0 })) as Envelope<{
      path?: string;
    }>;

    expect(result).toMatchObject({ ok: true, value: { path: target } });
    expect(new Uint8Array(await readFile(target))).toEqual(BYTES);
    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('saveResponse offers the attachment name, and the Content-ID plus an extension without one', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true });
    await invoke('attachments.saveResponse', { sendId: 'send-1', index: 0 });
    expect(showSaveDialog).toHaveBeenLastCalledWith(undefined, {
      title: 'Save attachment as…',
      defaultPath: 'logo.png',
    });

    await invoke('attachments.saveResponse', { sendId: 'send-1', index: 1 });
    expect(showSaveDialog).toHaveBeenLastCalledWith(undefined, {
      title: 'Save attachment as…',
      defaultPath: 'part2@wirebench.bin',
    });
  });

  it('saveResponse reports a cancelled dialog rather than writing', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true });

    const result = (await invoke('attachments.saveResponse', { sendId: 'send-1', index: 0 })) as Envelope<{
      cancelled?: boolean;
    }>;

    expect(result).toEqual({ ok: true, value: { cancelled: true } });
  });

  it('saveResponse answers unknown-attachment for an evicted send or a bad index', async () => {
    expect(await invoke('attachments.saveResponse', { sendId: 'gone', index: 0 })).toMatchObject({
      ok: false,
      error: { code: 'unknown-attachment' },
    });
    expect(await invoke('attachments.saveResponse', { sendId: 'send-1', index: 9 })).toMatchObject({
      ok: false,
      error: { code: 'unknown-attachment' },
    });
  });

  it('openResponse writes a temp copy under userData and opens it', async () => {
    const result = (await invoke('attachments.openResponse', { sendId: 'send-1', index: 0 })) as Envelope<{
      path: string;
    }>;

    expect(result.ok).toBe(true);
    const path = (result as { ok: true; value: { path: string } }).value.path;
    expect(path).toBe(join(dir, ATTACHMENTS_TMP_DIR, 'send-1-0.png'));
    expect(new Uint8Array(await readFile(path))).toEqual(BYTES);
    expect(openPath).toHaveBeenCalledWith(path);
  });

  it('openResponse surfaces a shell failure instead of reporting success', async () => {
    openPath.mockResolvedValue('no application knows how to open this');

    expect(await invoke('attachments.openResponse', { sendId: 'send-1', index: 0 })).toMatchObject({
      ok: false,
      error: { code: 'open-failed' },
    });
  });

  it('openRequest opens the path the project service allows', async () => {
    const file = join(dir, 'attached.pdf');
    await writeFile(file, 'pdf');
    resolveAttachmentPath.mockResolvedValue(file);

    const result = (await invoke('attachments.openRequest', {
      requestId: 'req-1',
      attachmentId: 'att-1',
    })) as Envelope<{ path: string }>;

    expect(result).toEqual({ ok: true, value: { path: file } });
    expect(resolveAttachmentPath).toHaveBeenCalledWith('req-1', 'att-1');
    expect(openPath).toHaveBeenCalledWith(file);
  });

  it('openRequest refuses a path outside the project without touching the shell', async () => {
    resolveAttachmentPath.mockRejectedValue(
      Object.assign(new Error('The attachment "x" is outside the project'), { code: 'attachment-outside-project' }),
    );

    expect(await invoke('attachments.openRequest', { requestId: 'req-1', attachmentId: 'att-1' })).toMatchObject({
      ok: false,
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('pickFiles returns every selected path, and splits the e2e override on commas', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a.png', '/b.pdf'] });
    expect(await invoke('attachments.pickFiles', {})).toEqual({ ok: true, value: { paths: ['/a.png', '/b.pdf'] } });
    expect(showOpenDialog).toHaveBeenCalledWith(undefined, {
      title: 'Add attachments',
      properties: ['openFile', 'multiSelections'],
    });

    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await invoke('attachments.pickFiles', {})).toEqual({ ok: true, value: { paths: [] } });

    process.env['WIREBENCH_E2E_OPEN_PATH'] = '/one.png,/two.png';
    expect(await invoke('attachments.pickFiles', {})).toEqual({
      ok: true,
      value: { paths: ['/one.png', '/two.png'] },
    });
  });

  it('does not let a Content-ID with separators steer the temp file out of its folder', async () => {
    handlers.clear();
    registerAttachmentChannels({
      exchanges: { getAttachment: () => ({ ...UNNAMED, contentType: 'image/png', contentId: '../../escaped' }) },
      project: { resolveAttachmentPath: () => Promise.resolve('') },
      userDataDir: dir,
    });

    const result = (await invoke('attachments.openResponse', { sendId: '../../escape', index: 0 })) as Envelope<{
      path: string;
    }>;

    const path = (result as { ok: true; value: { path: string } }).value.path;
    expect(path).toBe(join(dir, ATTACHMENTS_TMP_DIR, '____escape-0.png'));
    expect(existsSync(path)).toBe(true);
  });
});

describe('extensionForContentType', () => {
  it.each([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/gif', '.gif'],
    ['application/pdf', '.pdf'],
    ['application/xml', '.xml'],
    ['text/xml; charset=utf-8', '.xml'],
    ['text/plain', '.txt'],
    ['application/json', '.json'],
    ['application/zip', '.zip'],
    ['application/octet-stream', '.bin'],
  ])('maps %s to %s', (contentType, expected) => {
    expect(extensionForContentType(contentType)).toBe(expected);
  });
});
