// @vitest-environment node
/**
 * The e2e folder-picker overrides: `WIREBENCH_E2E_DIALOG_FOLDERS` answers successive picks in
 * order, then (or when unset) every pick falls back to `WIREBENCH_E2E_DIALOG_FOLDER`.
 */
import { delimiter } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { DialogPicks } from '../src/main/dialog-picks.js';

const showOpenDialog = vi.fn();

/** What `app.isPackaged` answers; the overrides are honoured only in an unpackaged run. */
let packaged = false;

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return packaged;
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) as unknown },
}));

const SENDER = {} as WebContents;

async function loadFresh() {
  // The queue position is module state; each test starts from a fresh module.
  vi.resetModules();
  return await import('../src/main/native-dialogs.js');
}

describe('folder picker e2e overrides', () => {
  beforeEach(() => {
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDERS'];
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
    delete process.env['WIREBENCH_E2E_DIALOG_SAVE'];
    delete process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'];
    packaged = false;
    showOpenDialog.mockReset();
  });
  afterEach(() => {
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDERS'];
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
    delete process.env['WIREBENCH_E2E_DIALOG_SAVE'];
    delete process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'];
    packaged = false;
  });

  it('answers from the queue in order across both pickers, then falls back to the single folder', async () => {
    process.env['WIREBENCH_E2E_DIALOG_FOLDERS'] = ['/e2e/export', '/e2e/link'].join(delimiter);
    process.env['WIREBENCH_E2E_DIALOG_FOLDER'] = '/e2e/fallback';
    const { pickFolder, pickFolderToWrite } = await loadFresh();
    const picks = new DialogPicks();

    expect(await pickFolderToWrite(SENDER, picks)).toBe('/e2e/export');
    expect(await pickFolder(SENDER, {}, picks)).toBe('/e2e/link');
    expect(await pickFolder(SENDER, {}, picks)).toBe('/e2e/fallback');
    expect(picks.hasWrite('/e2e/export')).toBe(true);
    expect(picks.hasRead('/e2e/link')).toBe(true);
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('uses the single folder when no queue is set', async () => {
    process.env['WIREBENCH_E2E_DIALOG_FOLDER'] = '/e2e/only';
    const { pickFolder } = await loadFresh();

    expect(await pickFolder(SENDER)).toBe('/e2e/only');
    expect(await pickFolder(SENDER)).toBe('/e2e/only');
  });

  it('runs the real dialog once the queue is spent and there is no fallback', async () => {
    process.env['WIREBENCH_E2E_DIALOG_FOLDERS'] = '/e2e/one';
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const { pickFolder } = await loadFresh();

    expect(await pickFolder(SENDER)).toBe('/e2e/one');
    expect(await pickFolder(SENDER)).toBeUndefined();
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
  });
});

/**
 * The overrides exist so Playwright can answer a picker it cannot drive, and every e2e run is
 * unpackaged. In a shipped build an environment variable must not be able to decide which
 * folder the app links, exports to or reads from — without any dialog the user ever saw.
 */
describe('a packaged app', () => {
  beforeEach(() => {
    packaged = true;
    showOpenDialog.mockReset();
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  });
  afterEach(() => {
    packaged = false;
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDERS'];
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
    delete process.env['WIREBENCH_E2E_DIALOG_SAVE'];
    delete process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'];
  });

  it('ignores every dialog override and runs the real picker', async () => {
    process.env['WIREBENCH_E2E_DIALOG_FOLDERS'] = ['/e2e/export', '/e2e/link'].join(delimiter);
    process.env['WIREBENCH_E2E_DIALOG_FOLDER'] = '/e2e/fallback';
    process.env['WIREBENCH_E2E_DIALOG_SAVE'] = '/e2e/save.xml';
    process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'] = '/e2e/open.xml';
    const { pickFile, pickFolder, pickFolderToWrite } = await loadFresh();
    const picks = new DialogPicks();

    expect(await pickFolder(SENDER, {}, picks)).toBeUndefined();
    expect(await pickFolderToWrite(SENDER, picks)).toBeUndefined();
    expect(await pickFile(SENDER, picks, {})).toBeUndefined();
    expect(showOpenDialog).toHaveBeenCalledTimes(3);
    expect(picks.hasRead('/e2e/fallback')).toBe(false);
    expect(picks.hasRead('/e2e/open.xml')).toBe(false);
    expect(picks.hasWrite('/e2e/fallback')).toBe(false);
  });
});
