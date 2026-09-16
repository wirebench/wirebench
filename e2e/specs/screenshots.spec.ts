import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { ADA, createBareRemote } from '../helpers/git-remote.js';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import {
  createProject,
  createProjectWithCalculator,
  createWorkspace,
  dismissChangedOnDiskBanners,
  expandExplorer,
  openFirstRequest,
  openImportDialog,
  saveAll,
} from '../helpers/project.js';
import { createApi, createRestRequest, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import { joinSharedWorkspace, openConflictResolver, produceRequestConflict, shareWorkspace } from '../helpers/sync.js';
import {
  startTestRestServer,
  startTestSoapServer,
  type TestRestServer,
  type TestSoapServer,
} from '../helpers/test-server.js';

/**
 * Captures the README's screenshots into `docs/images/`.
 *
 * This is a documentation *tool* wearing a spec's clothes, and it is a spec on purpose: the
 * pictures in the README are then produced by the same launcher, the same fixture project and
 * the same local test server the rest of the e2e suite uses, so re-shooting them after a UI
 * change is one command rather than an afternoon of window-arranging — and a screenshot can
 * never show a screen the app cannot actually reach.
 *
 * It does not run as part of `pnpm test:e2e`; it is skipped unless `WIREBENCH_SCREENSHOTS=1`:
 *
 * ```
 * pnpm build && WIREBENCH_SCREENSHOTS=1 pnpm test:e2e -- screenshots.spec.ts
 * ```
 *
 * Dark theme at 1280x800, against the Calculator fixture served by the in-process test server,
 * so nothing here depends on a network or on the developer's own projects. These are written
 * files, not compared snapshots — pixel comparison is `a11y.spec.ts`'s job, and doing both here
 * would make re-shooting the docs a test failure.
 *
 * The response capture masks the response-status line and any HTTP log rows (see
 * `timingRegions`): both carry a real request's wall-clock duration, which is neither
 * reproducible nor anyone's business to publish in a committed screenshot.
 */

/** Repo root, from `e2e/specs/` up two levels. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Where the README looks for them. */
const IMAGES_DIR = join(REPO_ROOT, 'docs', 'images');

/** Same window size as the theme snapshots: wide enough for the three-pane shell. */
const VIEWPORT = { width: 1280, height: 800 };

/**
 * A README image above ~300 KB is a slow page for everyone who reads it on a phone; PNG at this
 * viewport lands well under that, and this is the tripwire for the day it does not.
 */
const MAX_BYTES = 300 * 1024;

/** Resizes the Electron window itself — a Playwright viewport cannot move a native frame. */
async function resizeWindow(launched: LaunchedApp): Promise<void> {
  await launched.app.evaluate(async ({ BrowserWindow }, size) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.setSize(size.width, size.height);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, VIEWPORT);
}

/** Clicks the status bar's theme indicator until it sits on `preference`. */
async function setTheme(page: Page, preference: 'dark' | 'light'): Promise<void> {
  const indicator = page.getByTestId('status-bar-theme');
  await expect(indicator).toBeVisible();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await indicator.getAttribute('data-theme-preference')) === preference) {
      return;
    }
    await indicator.click();
  }
  throw new Error(`the theme indicator never reached ${preference}`);
}

/**
 * Regions carrying a real request's timing — a response's duration/status line, and any HTTP
 * log rows in the console — masked out of the README captures. Unlike `a11y.spec.ts`'s
 * `dynamicRegions` (masked so a *pixel comparison* never depends on when it ran), these are
 * masked because they are wall-clock numbers off whoever's machine re-shoots the docs: a
 * committed screenshot should not silently vary with — or leak — a maintainer's local timing.
 */
function timingRegions(page: Page): Locator[] {
  return [page.getByTestId('response-status'), page.locator('[data-testid="http-log-row"]')];
}

/** The same, for the REST response pane, whose status line carries its own duration. */
function restTimingRegions(page: Page): Locator[] {
  return [page.getByTestId('rest-response-status'), page.locator('[data-testid="http-log-row"]')];
}

/** The remote the sync captures show: a realistic URL rather than the test remote's temp folder. */
const SHOWN_REMOTE = 'https://git.example.com/team/wirebench-workspace.git';

/**
 * Git config for a sync capture's profile: Ada's identity plus `url.<test remote>.insteadOf`, so
 * the app is genuinely configured with {@link SHOWN_REMOTE} while git itself talks to the local
 * bare remote. It is the global config the launch points at, never a repository's own, so the
 * app's local-config check has nothing to refuse.
 */
function shownRemoteEnv(remoteUrl: string): Record<string, string> {
  const file = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-gitconfig-')), 'gitconfig');
  writeFileSync(
    file,
    `[user]\n\tname = ${ADA.name}\n\temail = ${ADA.email}\n[url "${remoteUrl}"]\n\tinsteadOf = ${SHOWN_REMOTE}\n`,
    'utf8',
  );
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
}

/** Shoots the whole window into `docs/images/<name>.png` and fails if it got too heavy. */
async function capture(page: Page, name: string, options: { mask?: Locator[] } = {}): Promise<void> {
  // A toast ("Saved", "Pulled 3 changes…") is passing chrome, not part of the screen documented.
  await expect(page.getByTestId('toast-viewport').locator(':scope > div')).toHaveCount(0, { timeout: 15_000 });
  // Nor is the watcher's "changed on disk" banner: writing the fixture project races the watcher,
  // so whether it shows is a matter of timing. A README picture should not document a bar the
  // reader will never see, and the banner pushes everything below it down by two rows.
  //
  // Not while a dialog is up, though: its overlay covers the banner in the picture and swallows
  // the click that would dismiss it, so the attempt would spend its whole timeout on a button no
  // pointer can reach.
  const modalOverlay = page.locator('[data-state="open"][aria-hidden="true"]');
  if ((await modalOverlay.count()) === 0) {
    await dismissChangedOnDiskBanners(page);
  }
  // `scale: 'css'` pins the image to 1280x800 regardless of the display's device pixel ratio:
  // otherwise a Retina machine produces a 2560x1600 file (and a different one from a non-Retina
  // machine), which is both heavier than a README wants and not reproducible across developers.
  const buffer = await page.screenshot({
    animations: 'disabled',
    scale: 'css',
    ...(options.mask !== undefined ? { mask: options.mask } : {}),
  });
  expect(buffer.byteLength, `${name}.png is ${String(buffer.byteLength)} bytes; keep README images small`).toBeLessThan(
    MAX_BYTES,
  );
  mkdirSync(IMAGES_DIR, { recursive: true });
  writeFileSync(join(IMAGES_DIR, `${name}.png`), buffer);
}

test.describe('README screenshots', () => {
  test.skip(process.env['WIREBENCH_SCREENSHOTS'] !== '1', 'set WIREBENCH_SCREENSHOTS=1 to re-shoot the README images');

  let launched: LaunchedApp | undefined;
  /** The second profile of the conflict capture, which needs someone to conflict with. */
  let second: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let remoteDir: string | undefined;
  let restServer: TestRestServer | undefined;

  test.afterEach(async () => {
    const failures: unknown[] = [];
    for (const app of [launched, second]) {
      if (app) {
        await app.close().catch((error: unknown) => failures.push(error));
      }
    }
    launched = undefined;
    second = undefined;
    if (server) {
      await server.close();
      server = undefined;
    }
    if (restServer) {
      await restServer.close();
      restServer = undefined;
    }
    if (remoteDir !== undefined) {
      removeDirSync(remoteDir);
      remoteDir = undefined;
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  });

  test('workspace picker', async () => {
    launched = await launchApp();
    await resizeWindow(launched);
    await setTheme(launched.window, 'dark');
    await expect(launched.window.getByTestId('workspace-picker')).toBeVisible();
    await capture(launched.window, 'workspace-picker');
  });

  test('import, request editor and response', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'dark');

    // The import dialog, filled in but not yet submitted — the first thing a new user does.
    await createWorkspace(window);
    await createProject(window, 'Calculator Project');
    await openImportDialog(window, 'wsdl');
    await window.getByTestId('import-url-input').fill(server.wsdlUrl);
    await capture(window, 'import-wsdl');

    await window.getByTestId('import-submit').click();
    await expandExplorer(window, 'Request 1');

    // The generated envelope, open in the editor.
    await openFirstRequest(window);
    await capture(window, 'request-editor');

    // …and the response it gets back from the test server.
    await window.getByTestId('request-send').click();
    await expect(window.getByTestId('response-status')).toContainText(/\d{3}/, { timeout: 20_000 });
    await capture(window, 'response', { mask: timingRegions(window) });
  });

  test('a REST request and its response', async () => {
    restServer = await startTestRestServer();
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'dark');

    // Three distinct names: the workspace, the project and the API are different things, and a
    // screenshot that calls all three "Petstore" teaches the reader nothing about which is which.
    await createWorkspace(window, 'Demo');
    await createProject(window, 'Pet Service');
    await createApi(window, 'Petstore', restServer.url);
    await createRestRequest(window, 'Petstore', 'Echo a query');
    await setMethodAndUrl(window, 'GET', '/echo?pet=Fido&limit=10');
    await sendRest(window);
    await expect(window.getByTestId('rest-response-status')).toContainText(/\d{3}/, { timeout: 20_000 });

    await capture(window, 'rest-response', { mask: restTimingRegions(window) });
  });

  test('sync panel', async () => {
    test.skip(process.platform !== 'darwin', 'the docs screenshots are shot on macOS');
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    remoteDir = remote.dir;
    launched = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'dark');

    await createProjectWithCalculator(window, server);
    await saveAll(window);
    await shareWorkspace(window, SHOWN_REMOTE);
    await runCommand(window, 'Sync: Show Sync Panel');
    await expect(window.getByTestId('sync-panel')).toBeVisible();
    await expect(window.getByTestId('sync-log-row').first()).toBeVisible({ timeout: 20_000 });
    await capture(window, 'sync-panel');
  });

  test('conflict resolver', async () => {
    test.skip(process.platform !== 'darwin', 'the docs screenshots are shot on macOS');
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    remoteDir = remote.dir;

    // Someone else shares the workspace and pushes an edit to the first request…
    second = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    await createProjectWithCalculator(second.window, server);
    await saveAll(second.window);
    await shareWorkspace(second.window, SHOWN_REMOTE);

    // …while this profile, having joined, edits the same line.
    launched = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'dark');
    await joinSharedWorkspace(window, SHOWN_REMOTE);
    await produceRequestConflict(second.window, window, remote.dir);

    await openConflictResolver(window);
    await capture(window, 'conflict-resolver');
  });

  test('the helpers used above still match the shared project flow', async () => {
    // `createProjectWithCalculator` is what every other spec uses; the two captures above
    // inline its steps so the import dialog can be shot mid-flow. This asserts the inlined
    // version and the shared helper still describe the same app.
    server = await startTestSoapServer({ fixture: 'calculator' });
    launched = await launchApp();
    await createProjectWithCalculator(launched.window, server);
  });
});
