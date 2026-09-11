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

vi.mock('electron', () => ({
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
    showOpenDialog.mockReset();
  });
  afterEach(() => {
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDERS'];
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
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
