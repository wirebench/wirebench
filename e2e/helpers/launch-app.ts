import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { MAIN_PATH } from '../global-setup.js';

/** A launched app under test, plus a `close()` that also asserts the console stayed clean. */
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
export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-'));
  const consoleErrors: string[] = [];

  try {
    const app = await electron.launch({
      args: [MAIN_PATH],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        WIREBENCH_E2E: '1',
        WIREBENCH_USER_DATA_DIR: userDataDir,
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
        await app.close();
        rmSync(userDataDir, { recursive: true, force: true });
        const unexpected = consoleErrors.filter(
          (text) => !BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text)),
        );
        expect(unexpected, `unexpected renderer console errors:\n${unexpected.join('\n')}`).toEqual([]);
      },
    };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}
