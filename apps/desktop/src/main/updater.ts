/**
 * The update check: an opt-in, consent-gated wrapper around `electron-updater`.
 *
 * Wirebench never updates itself behind the user's back. Nothing here runs unless the user
 * asked for it — either by running "Check for Updates…" or by turning on the (default off)
 * `updates.checkOnLaunch` preference — and even then the app contacts GitHub Releases, and
 * nothing else, to read a version number. Downloading takes one confirmation, installing takes
 * a second one, and a check that fails (no network, no release feed, a 404) is a message in
 * the UI rather than a dialog, a retry loop or a crash.
 *
 * `electron-updater` itself is injected as {@link UpdaterBackend} and the dialogs as
 * {@link UpdaterUi}, so the whole state machine is unit-testable without Electron: see
 * `test/updater.test.ts`. `main/index.ts` supplies the real ones.
 */

/** The slice of `electron-updater`'s `AppUpdater` this controller drives. */
export interface UpdaterBackend {
  /** Set to `false` on construction: a download is the user's decision, not a side effect. */
  autoDownload: boolean;
  /** Set to `false` on construction: quitting the app must never silently install anything. */
  autoInstallOnAppQuit: boolean;
  /** Resolves with the release info when one is available, `null`/`undefined` when none is. */
  checkForUpdates(): Promise<{ readonly updateInfo: { readonly version: string } } | null | undefined>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: 'download-progress', listener: (progress: { readonly percent: number }) => void): void;
}

/** What the controller needs from the UI: two consents and somewhere to report progress. */
export interface UpdaterUi {
  confirmDownload(version: string): Promise<boolean>;
  confirmInstall(version: string): Promise<boolean>;
  report(status: UpdateStatus): void;
}

/**
 * Where a check got to. Also the `app.checkForUpdates` response, so the renderer can render
 * the same vocabulary in a toast and in the status bar.
 */
export type UpdateStatus =
  | { readonly kind: 'checking' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'downloading'; readonly percent: number }
  | { readonly kind: 'declined'; readonly version: string }
  | { readonly kind: 'downloaded'; readonly version: string }
  | { readonly kind: 'installing'; readonly version: string }
  | { readonly kind: 'error'; readonly message: string };

/** Shown for every failed check, whatever went wrong — the user can only do one thing about it. */
const CHECK_FAILED = 'Could not check for updates';
const DOWNLOAD_FAILED = 'Could not download the update';

/** Options; `feedConfigured` is false when `package.json` carries no usable `repository`. */
export interface UpdateControllerOptions {
  readonly feedConfigured?: boolean;
}

/**
 * Matches a GitHub repository URL *whole*, with `github.com` anchored as the host.
 *
 * The anchoring is the point: an unanchored `github.com[:/]…` also matches
 * `https://github.com.evil.example/a/b` and `https://evil.example/github.com/a/b`, which would
 * hand the updater an owner/repo pair derived from a host nobody vetted. Only the scheme, an
 * optional `user@`, the literal host, and exactly two path segments are accepted.
 */
const GITHUB_REPOSITORY_URL =
  /^(?:git\+)?(?:(?:https?|git|ssh):\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/**
 * Parses `owner`/`repo` out of a `package.json` `repository.url`. Only github.com is
 * recognised — the GitHub Releases provider is the only feed Wirebench ships — so a missing,
 * malformed or non-GitHub URL yields `undefined`, which the controller reports as a failed
 * check rather than pointing the updater at a feed that cannot exist.
 */
export function githubFeedFrom(url: string | undefined): { readonly owner: string; readonly repo: string } | undefined {
  const match = GITHUB_REPOSITORY_URL.exec(url ?? '');
  const owner = match?.[1];
  const repo = match?.[2];
  return owner === undefined || repo === undefined ? undefined : { owner, repo };
}

/**
 * Drives one update check from start to finish, serialising checks so a menu click during a
 * download cannot start a second one.
 */
export class UpdateController {
  private running = false;

  constructor(
    private readonly backend: UpdaterBackend,
    private readonly ui: UpdaterUi,
    private readonly options: UpdateControllerOptions = {},
  ) {
    this.backend.autoDownload = false;
    this.backend.autoInstallOnAppQuit = false;
    this.backend.on('download-progress', (progress) => {
      this.ui.report({ kind: 'downloading', percent: Math.round(progress.percent) });
    });
  }

  /**
   * Runs the check-download-install conversation.
   *
   * A `launch` check is silent unless it has something to offer: an opt-in background check
   * that pops "you are up to date" (or "the network is down") at every start would be a
   * nuisance, and the user did not ask a question this time.
   *
   * @param trigger who started the check
   * @returns where it got to; never rejects
   */
  async check({ trigger }: { readonly trigger: 'launch' | 'user' }): Promise<UpdateStatus> {
    if (this.running) {
      return this.settle({ kind: 'busy' }, trigger);
    }
    if (this.options.feedConfigured === false) {
      return this.settle({ kind: 'error', message: CHECK_FAILED }, trigger);
    }

    this.running = true;
    try {
      if (trigger === 'user') {
        this.ui.report({ kind: 'checking' });
      }
      const result = await this.backend.checkForUpdates().catch(() => undefined);
      const version = result?.updateInfo.version;
      if (version === undefined) {
        // `undefined` covers both "no update" and a failed check; the two are indistinguishable
        // to the user (nothing to install) and neither is worth a dialog on launch.
        return this.settle(
          result === undefined ? { kind: 'error', message: CHECK_FAILED } : { kind: 'up-to-date' },
          trigger,
        );
      }
      if (!(await this.ui.confirmDownload(version))) {
        return this.settle({ kind: 'declined', version }, 'user');
      }
      try {
        await this.backend.downloadUpdate();
      } catch {
        return this.settle({ kind: 'error', message: DOWNLOAD_FAILED }, 'user');
      }
      if (!(await this.ui.confirmInstall(version))) {
        // The download stays on disk; `autoInstallOnAppQuit` is off, so nothing happens
        // until the user comes back and says yes.
        return this.settle({ kind: 'downloaded', version }, 'user');
      }
      const installing: UpdateStatus = { kind: 'installing', version };
      this.ui.report(installing);
      this.backend.quitAndInstall();
      return installing;
    } finally {
      this.running = false;
    }
  }

  /** Runs a launch check if — and only if — `enabled()` says the user opted in. */
  async checkOnLaunch(enabled: () => boolean): Promise<UpdateStatus | undefined> {
    return enabled() ? await this.check({ trigger: 'launch' }) : undefined;
  }

  /** Reports `status` unless this was a silent launch check with nothing to say. */
  private settle(status: UpdateStatus, trigger: 'launch' | 'user'): UpdateStatus {
    if (trigger === 'user') {
      this.ui.report(status);
    }
    return status;
  }
}
