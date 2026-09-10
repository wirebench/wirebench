import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { MAIN_PATH } from '../global-setup.js';

/** A launched app under test, plus a `close()` that also asserts the console stayed clean. */
/** Per-launch overrides; everything is optional and defaults to a throwaway profile. */
export interface LaunchOptions {
  /** Reuse a profile across launches — what "relaunch and find it in Recent" needs. */
  readonly userDataDir?: string;
  /** Fixed answer for `dialogs.openFolder`, since a native picker cannot be driven. */
  readonly folderDialogPath?: string;
  /** Skip removing `userDataDir` on close (it is the caller's, not ours, when reused). */
  readonly keepUserDataDir?: boolean;
}

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  readonly userDataDir: string;
  close(): Promise<void>;
}

// Renderer console messages that are expected/benign and must not fail a spec. Kept explicit
// and, ideally, empty — anything added here should be a link to why it's unavoidable.
const BENIGN_CONSOLE_PATTERNS: readonly RegExp[] = [];

/**
 * Launches the built desktop app against a fresh, isolated `userData` directory (so specs
 * never share state, and never touch the developer's real profile) and waits for its first
 * window to render the shell. Every renderer console error is collected; `close()` fails the
 * test if any were seen, unless they match {@link BENIGN_CONSOLE_PATTERNS}.
 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'wirebench-e2e-'));
  const consoleErrors: string[] = [];
  let app: ElectronApplication | undefined;

  try {
    app = await electron.launch({
      args: [MAIN_PATH],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        WIREBENCH_E2E: '1',
        WIREBENCH_USER_DATA_DIR: userDataDir,
        // Playwright cannot drive a native folder picker, so specs that create or open a
        // project pin what `dialogs.openFolder` returns (see `main/ipc/dialogs.ts`).
        ...(options.folderDialogPath !== undefined ? { WIREBENCH_E2E_DIALOG_FOLDER: options.folderDialogPath } : {}),
      },
    });

    const window = await app.firstWindow();
    window.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await window.waitForSelector('[data-testid="activity-bar"]');

    return {
      app,
      window,
      userDataDir,
      async close(): Promise<void> {
        await app!.close();
        if (options.keepUserDataDir !== true) {
          rmSync(userDataDir, { recursive: true, force: true });
        }
        const unexpected = consoleErrors.filter(
          (text) => !BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text)),
        );
        expect(unexpected, `unexpected renderer console errors:\n${unexpected.join('\n')}`).toEqual([]);
      },
    };
  } catch (error) {
    if (app) {
      try {
        await app.close();
      } catch {
        /* ignore */
      }
    }
    if (options.keepUserDataDir !== true) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    throw error;
  }
}
