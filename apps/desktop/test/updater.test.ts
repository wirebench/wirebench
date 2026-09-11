import { describe, expect, it, vi } from 'vitest';
import { githubFeedFrom, UpdateController } from '../src/main/updater.js';
import type { UpdaterBackend, UpdaterUi, UpdateStatus } from '../src/main/updater.js';

/** A fake `electron-updater` `AppUpdater`: records what was asked of it, answers as scripted. */
function fakeBackend(script: Partial<UpdaterBackend> = {}): UpdaterBackend & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    async checkForUpdates() {
      calls.push('check');
      return script.checkForUpdates === undefined ? null : await script.checkForUpdates();
    },
    async downloadUpdate() {
      calls.push('download');
      await script.downloadUpdate?.();
    },
    quitAndInstall() {
      calls.push('install');
    },
    on() {
      /* no progress in the default script */
    },
  };
}

/** A fake UI that answers every consent prompt the same way and records what it was told. */
function fakeUi(answers: { download?: boolean; install?: boolean } = {}): UpdaterUi & {
  readonly statuses: UpdateStatus[];
} {
  const statuses: UpdateStatus[] = [];
  return {
    statuses,
    confirmDownload: () => Promise.resolve(answers.download ?? false),
    confirmInstall: () => Promise.resolve(answers.install ?? false),
    report: (status) => statuses.push(status),
  };
}

const AVAILABLE = { updateInfo: { version: '9.9.9' } };

describe('githubFeedFrom', () => {
  it('reads owner and repo out of a git URL', () => {
    expect(githubFeedFrom('https://github.com/wirebench/wirebench.git')).toEqual({
      owner: 'wirebench',
      repo: 'wirebench',
    });
  });

  it('accepts the ssh and no-suffix spellings', () => {
    expect(githubFeedFrom('git@github.com:wirebench/wirebench.git')).toEqual({
      owner: 'wirebench',
      repo: 'wirebench',
    });
    expect(githubFeedFrom('https://github.com/wirebench/wirebench')).toEqual({
      owner: 'wirebench',
      repo: 'wirebench',
    });
  });

  it('is undefined for anything that is not a GitHub repository', () => {
    expect(githubFeedFrom(undefined)).toBeUndefined();
    expect(githubFeedFrom('')).toBeUndefined();
    expect(githubFeedFrom('https://gitlab.com/wirebench/wirebench.git')).toBeUndefined();
  });
});

describe('UpdateController', () => {
  it('never lets the backend download or install on its own', () => {
    const backend = fakeBackend();
    new UpdateController(backend, fakeUi());

    expect(backend.autoDownload).toBe(false);
    expect(backend.autoInstallOnAppQuit).toBe(false);
  });

  it('reports "up to date" and downloads nothing when there is no update', async () => {
    const backend = fakeBackend();
    const ui = fakeUi({ download: true });

    expect(await new UpdateController(backend, ui).check({ trigger: 'user' })).toEqual({ kind: 'up-to-date' });
    expect(backend.calls).toEqual(['check']);
  });

  it('asks before downloading, and stops there when the user says no', async () => {
    const backend = fakeBackend({ checkForUpdates: () => Promise.resolve(AVAILABLE) });
    const ui = fakeUi({ download: false });

    expect(await new UpdateController(backend, ui).check({ trigger: 'user' })).toEqual({
      kind: 'declined',
      version: '9.9.9',
    });
    expect(backend.calls).toEqual(['check']);
  });

  it('asks again before installing, and leaves the update downloaded when the user says no', async () => {
    const backend = fakeBackend({ checkForUpdates: () => Promise.resolve(AVAILABLE) });
    const ui = fakeUi({ download: true, install: false });

    expect(await new UpdateController(backend, ui).check({ trigger: 'user' })).toEqual({
      kind: 'downloaded',
      version: '9.9.9',
    });
    expect(backend.calls).toEqual(['check', 'download']);
  });

  it('installs only after both consents', async () => {
    const backend = fakeBackend({ checkForUpdates: () => Promise.resolve(AVAILABLE) });

    expect(
      await new UpdateController(backend, fakeUi({ download: true, install: true })).check({ trigger: 'user' }),
    ).toEqual({ kind: 'installing', version: '9.9.9' });
    expect(backend.calls).toEqual(['check', 'download', 'install']);
  });

  it('reports download progress as it arrives', async () => {
    const listeners: ((progress: { percent: number }) => void)[] = [];
    const backend = fakeBackend({
      checkForUpdates: () => Promise.resolve(AVAILABLE),
      downloadUpdate: () => {
        for (const listener of listeners) {
          listener({ percent: 42.4 });
        }
        return Promise.resolve();
      },
    });
    backend.on = (_event, listener) => listeners.push(listener);
    const ui = fakeUi({ download: true, install: false });

    await new UpdateController(backend, ui).check({ trigger: 'user' });

    expect(ui.statuses).toContainEqual({ kind: 'downloading', percent: 42 });
  });

  it('turns an offline check into a reported error, never a throw', async () => {
    const backend = fakeBackend({ checkForUpdates: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) });
    const ui = fakeUi();

    expect(await new UpdateController(backend, ui).check({ trigger: 'user' })).toEqual({
      kind: 'error',
      message: 'Could not check for updates',
    });
    expect(ui.statuses.at(-1)).toEqual({ kind: 'error', message: 'Could not check for updates' });
  });

  it('turns a failed download into a reported error', async () => {
    const backend = fakeBackend({
      checkForUpdates: () => Promise.resolve(AVAILABLE),
      downloadUpdate: () => Promise.reject(new Error('404')),
    });
    const ui = fakeUi({ download: true });

    expect(await new UpdateController(backend, ui).check({ trigger: 'user' })).toEqual({
      kind: 'error',
      message: 'Could not download the update',
    });
  });

  it('says so, without contacting anything, when no update feed is configured', async () => {
    const backend = fakeBackend();
    const ui = fakeUi();

    expect(await new UpdateController(backend, ui, { feedConfigured: false }).check({ trigger: 'user' })).toEqual({
      kind: 'error',
      message: 'Could not check for updates',
    });
    expect(backend.calls).toEqual([]);
  });

  it('stays quiet about a launch check that found nothing, or failed', async () => {
    const upToDate = new UpdateController(fakeBackend(), fakeUi());
    const ui = fakeUi();
    const failing = new UpdateController(
      fakeBackend({ checkForUpdates: () => Promise.reject(new Error('offline')) }),
      ui,
    );

    await upToDate.check({ trigger: 'launch' });
    await failing.check({ trigger: 'launch' });

    expect(ui.statuses).toEqual([]);
  });

  it('runs one check at a time', async () => {
    let release = (): void => undefined;
    const backend = fakeBackend({
      checkForUpdates: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return null;
      },
    });
    const controller = new UpdateController(backend, fakeUi());

    const first = controller.check({ trigger: 'user' });
    const second = await controller.check({ trigger: 'user' });
    release();
    await first;

    expect(second).toEqual({ kind: 'busy' });
    expect(backend.calls).toEqual(['check']);
  });

  it('only checks on launch when the preference says so', async () => {
    const backend = fakeBackend();
    const controller = new UpdateController(backend, fakeUi());
    const checkOnLaunch = vi.fn(() => false);

    await controller.checkOnLaunch(checkOnLaunch);
    expect(backend.calls).toEqual([]);

    checkOnLaunch.mockReturnValue(true);
    await controller.checkOnLaunch(checkOnLaunch);
    expect(backend.calls).toEqual(['check']);
  });
});
