import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import {
  chromium,
  _electron as electron,
  expect,
  type Browser,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { MAIN_PATH } from '../global-setup.js';

/**
 * The packaged bundle under test, when there is one: `WIREBENCH_PACKAGED_APP` points at a
 * built `.app` (macOS) or at the executable itself on the other platforms, and
 * {@link launchPackagedApp} then drives the shipped artifact instead of `out/main/index.js`.
 * Unset — the normal case — only `packaged.spec.ts` notices, and it skips itself.
 */
export const PACKAGED_APP = process.env['WIREBENCH_PACKAGED_APP'];

/**
 * Removes a throwaway directory, retrying the "still held open" errors Windows raises.
 *
 * `rmSync`'s `force` only swallows `ENOENT`. A `userData` directory an Electron process has just
 * released — or that Defender is still scanning — fails with `EPERM`/`EBUSY` on win32 for a
 * moment afterwards, which is why every removal here goes through Node's own retry loop instead
 * of a bare `rmSync`.
 */
export function removeDirSync(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/**
 * Kills a launched app with no clean exit — a crash, as far as the app can tell — and waits
 * until it is gone.
 *
 * A plain `SIGKILL` is not enough on win32: it ends only the main process, and the orphaned
 * GPU/renderer/utility processes keep the `userData` directory locked, so removing it afterwards
 * fails with `EPERM`. `taskkill /T` takes the whole tree down instead.
 */
export async function killApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once('exit', () => resolve());
    }
  });
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
  await exited;
}

/** How long a graceful `app.close()` is given before the process tree is killed instead. */
const GRACEFUL_CLOSE_MS = 15_000;

/**
 * Closes the app, falling back to {@link killApp} if it does not exit in time.
 *
 * Playwright's `close()` asks the app to quit and then waits indefinitely, so a main process that
 * will not exit — a socket it still holds, a quit handler that never settles — hangs the spec's
 * teardown and, after it, the whole worker, taking every other test on that worker down with it.
 * A bounded wait turns that into one killed process. Nothing else is skipped: the caller still
 * asserts on the console errors it collected.
 */
async function closeOrKill(app: ElectronApplication): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = Symbol('expired');
  const deadline = new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => resolve(expired), GRACEFUL_CLOSE_MS);
  });
  try {
    const outcome = await Promise.race([app.close().then(() => undefined), deadline]);
    if (outcome === expired) {
      await killApp(app);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The executable inside a packaged bundle. A macOS `.app` keeps it under
 * `Contents/MacOS/<name>`; on the other platforms the path already is the executable.
 */
export function packagedExecutable(appPath: string): string {
  return appPath.endsWith('.app')
    ? join(appPath, 'Contents', 'MacOS', basename(appPath).replace(/\.app$/, ''))
    : appPath;
}

/** Per-launch overrides; everything is optional and defaults to a throwaway profile. */
export interface LaunchOptions {
  /** Reuse a profile across launches — what "relaunch reopens the last workspace" needs. */
  readonly userDataDir?: string;
  /**
   * Fixed answer for every folder picker, since a native picker cannot be driven. Only for
   * the flows that genuinely pick a folder (link / import / export a project folder):
   * creating a project no longer involves one.
   */
  readonly folderDialogPath?: string;
  /**
   * Successive answers for the folder pickers, in order (export, then link back, in one
   * launch); once spent, the pickers fall back to {@link folderDialogPath}.
   */
  readonly folderDialogPaths?: readonly string[];
  /**
   * Where deleted workspaces and project folders go instead of the OS trash, so a spec can
   * assert what was "trashed". Never an `rm`: main moves the folder in here.
   */
  readonly trashDir?: string;
  /** Skip removing `userDataDir` on close (it is the caller's, not ours, when reused). */
  readonly keepUserDataDir?: boolean;
  /** Extra env vars for the launched process — e.g. `WIREBENCH_E2E_SAVE_PATH`/`WIREBENCH_E2E_OPEN_PATH`. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/** The env vars {@link LaunchOptions} translate into, shared by both launchers. */
function e2eEnv(options: LaunchOptions): Record<string, string> {
  return {
    ...(options.folderDialogPath !== undefined ? { WIREBENCH_E2E_DIALOG_FOLDER: options.folderDialogPath } : {}),
    ...(options.folderDialogPaths !== undefined
      ? { WIREBENCH_E2E_DIALOG_FOLDERS: options.folderDialogPaths.join(delimiter) }
      : {}),
    ...(options.trashDir !== undefined ? { WIREBENCH_E2E_TRASH_DIR: options.trashDir } : {}),
    ...options.extraEnv,
  };
}

/**
 * What the renderer shows once it knows whether a workspace is open: the IDE (its activity
 * bar) or the workspace picker. Neither appears before main's launch-time reopen settles.
 */
export const SHELL_READY_SELECTOR = '[data-testid="activity-bar"], [data-testid="workspace-picker"]';

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
        // Playwright cannot drive a native folder picker, so specs that link, import or export
        // a project folder pin what the pickers return (see `main/native-dialogs.ts`).
        ...e2eEnv(options),
      },
    });

    const window = await app.firstWindow();
    window.on('console', (message) => {
      if (process.env['WIREBENCH_E2E_DEBUG_CONSOLE'] === '1') {
        // Every renderer console line with its source, for diagnosing a failing console gate.
        console.log(`[renderer:${message.type()}] ${message.text()} @ ${JSON.stringify(message.location())}`);
      }
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    await window.waitForSelector(SHELL_READY_SELECTOR);

    return {
      app,
      window,
      userDataDir,
      async close(): Promise<void> {
        await closeOrKill(app!);
        if (options.keepUserDataDir !== true) {
          removeDirSync(userDataDir);
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
      removeDirSync(userDataDir);
    }
    throw error;
  }
}

/** A packaged app under test. No `ElectronApplication`: see {@link launchPackagedApp}. */
export interface LaunchedPackagedApp {
  readonly window: Page;
  readonly userDataDir: string;
  close(): Promise<void>;
}

/** An unused localhost port, claimed and released so the app can bind it a moment later. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Launches the *packaged* app and attaches to its renderer over Chromium's remote debugging
 * port.
 *
 * Playwright's `_electron.launch` cannot be used here: it drives the main process through
 * Node's inspector, and the shipped binary burns `EnableNodeCliInspectArguments` (and
 * `RunAsNode`) off — which is the whole point of the fuses. Attaching to the renderer over CDP
 * needs neither, so the spec drives exactly the binary a user would install, at the cost of
 * having no main-process handle (`app.evaluate`) — nothing the packaged spec needs.
 */
export async function launchPackagedApp(options: LaunchOptions = {}): Promise<LaunchedPackagedApp> {
  if (PACKAGED_APP === undefined) {
    throw new Error('WIREBENCH_PACKAGED_APP is not set');
  }
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'wirebench-e2e-'));
  const port = await freePort();
  const child = spawn(packagedExecutable(PACKAGED_APP), [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WIREBENCH_E2E: '1',
      WIREBENCH_USER_DATA_DIR: userDataDir,
      ...e2eEnv(options),
    },
    stdio: 'ignore',
  });

  const consoleErrors: string[] = [];
  let browser: Browser | undefined;
  try {
    // The port appears once Chromium is up; a crashed main process never gets that far, which
    // is exactly the failure this spec exists to catch, so the wait is bounded.
    let connected: Browser | undefined;
    for (let attempt = 0; attempt < 120 && connected === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
    }
    if (connected === undefined) {
      throw new Error(`packaged app never opened its debugging port (${packagedExecutable(PACKAGED_APP)})`);
    }
    browser = connected;
    const context = browser.contexts()[0];
    if (context === undefined) {
      throw new Error('packaged app exposed no browser context');
    }
    const window = context.pages()[0] ?? (await context.waitForEvent('page'));
    window.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    await window.waitForSelector(SHELL_READY_SELECTOR, { timeout: 60_000 });

    return {
      window,
      userDataDir,
      async close(): Promise<void> {
        await browser!.close();
        child.kill();
        if (options.keepUserDataDir !== true) {
          removeDirSync(userDataDir);
        }
        const unexpected = consoleErrors.filter(
          (text) => !BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(text)),
        );
        expect(unexpected, `unexpected renderer console errors:\n${unexpected.join('\n')}`).toEqual([]);
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    child.kill();
    if (options.keepUserDataDir !== true) {
      removeDirSync(userDataDir);
    }
    throw error;
  }
}
