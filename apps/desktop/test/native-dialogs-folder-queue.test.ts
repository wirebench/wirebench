// @vitest-environment node
/**
 * The e2e folder-picker overrides: `WIREBENCH_E2E_DIALOG_FOLDERS` answers successive picks in
 * order, then (or when unset) every pick falls back to `WIREBENCH_E2E_DIALOG_FOLDER`.
 */
import { delimiter } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform, fakeCaller } from './helpers/fake-platform.js';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { createNativeDialogs, type NativeDialogs } from '../src/main/native-dialogs.js';

const showOpenDialog = vi.fn();
const showSaveDialog = vi.fn();
const showMessage = vi.fn();

/** What `platform.app.packaged()` answers; the overrides are honoured only in an unpackaged run. */
let packaged = false;

const SENDER = fakeCaller();

/** Each call builds its own subject, so the queue position starts at the beginning. */
function subject(): NativeDialogs {
  return createNativeDialogs(
    createFakePlatform({
      app: { ...createFakePlatform().app, packaged: () => packaged },
      dialogs: {
        openFile: (owner, opts) => showOpenDialog(owner, opts) as Promise<{ canceled: boolean; filePaths: string[] }>,
        saveFile: (owner, opts) => showSaveDialog(owner, opts) as Promise<{ canceled: boolean; filePath?: string }>,
        message: (owner, opts) => showMessage(owner, opts) as Promise<{ response: number; checkboxChecked: boolean }>,
      },
    }),
  );
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
    const { pickFolder, pickFolderToWrite } = subject();
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
    const { pickFolder } = subject();

    expect(await pickFolder(SENDER)).toBe('/e2e/only');
    expect(await pickFolder(SENDER)).toBe('/e2e/only');
  });

  it('runs the real dialog once the queue is spent and there is no fallback', async () => {
    process.env['WIREBENCH_E2E_DIALOG_FOLDERS'] = '/e2e/one';
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const { pickFolder } = subject();

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
    const { pickFile, pickFolder, pickFolderToWrite } = subject();
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

describe('the pickers over the platform dialogs', () => {
  beforeEach(() => {
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDERS'];
    delete process.env['WIREBENCH_E2E_DIALOG_FOLDER'];
    delete process.env['WIREBENCH_E2E_DIALOG_SAVE'];
    delete process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'];
    packaged = false;
    showOpenDialog.mockReset();
    showSaveDialog.mockReset();
    showMessage.mockReset();
  });

  it('opens the picker over the asking caller and records the pick', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/chosen/a.xml'] });
    const picks = new DialogPicks();
    expect(await subject().pickFile(SENDER, picks, { title: 'Pick' })).toBe('/chosen/a.xml');
    expect(showOpenDialog).toHaveBeenCalledWith(SENDER, { properties: ['openFile'], title: 'Pick' });
    expect(picks.hasRead('/chosen/a.xml')).toBe(true);
  });

  it('asks the protected-environment question over no owner, so the focused window takes it', async () => {
    showMessage.mockResolvedValue({ response: 0, checkboxChecked: false });
    await expect(subject().confirmProtected(['Prod'])).resolves.toBe(true);
    expect(showMessage).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ buttons: ['Send', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Send to Prod?' }),
    );
    showMessage.mockResolvedValue({ response: 1, checkboxChecked: false });
    await expect(subject().confirmProtected(['Prod', 'Live'])).resolves.toBe(false);
  });

  it('refuses with host-capability-missing on a platform with no dialogs', async () => {
    const bare = createNativeDialogs(createFakePlatform());
    await expect(bare.pickFolder(SENDER)).rejects.toMatchObject({
      code: 'host-capability-missing',
      details: { capability: 'dialogs' },
    });
    await expect(bare.confirmProtected(['Prod'])).rejects.toMatchObject({ code: 'host-capability-missing' });
  });

  it('answers an e2e override even on a platform with no dialogs', async () => {
    process.env['WIREBENCH_E2E_DIALOG_FOLDER'] = '/e2e/only';
    await expect(createNativeDialogs(createFakePlatform()).pickFolder(SENDER)).resolves.toBe('/e2e/only');
  });
});
