import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  captureWindow,
  resizeWindow,
  restTimingRegions,
  setTheme,
  SHOWN_REMOTE,
  shownRemoteEnv,
  timingRegions,
} from '../helpers/capture.js';
import { createBareRemote } from '../helpers/git-remote.js';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import {
  createProject,
  createProjectWithCalculator,
  createWorkspace,
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
 * Captures the docs site's screenshots into `docs-site/public/images/<page>/<name>.png`.
 *
 * The same idea as `screenshots.spec.ts`, which shoots the README: every picture on the site is
 * produced by the real app against the in-process test servers, so it can only show a screen the
 * app can reach, and re-shooting after a UI change is one command. It is skipped unless
 * `WIREBENCH_DOCS_SCREENSHOTS=1`; `pnpm docs:screenshots` builds the app and sets it:
 *
 * ```
 * pnpm docs:screenshots
 * ```
 *
 * Light theme, unlike the README's dark one: the site's default reading theme is light. The
 * images are committed; `pnpm check:docs-images` fails when a page cites one that is not there,
 * or one is there that no page cites.
 */

/** Repo root, from `e2e/specs/` up two levels. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Where the site serves its images from, one folder per page. */
const IMAGES_DIR = join(REPO_ROOT, 'docs-site', 'public', 'images');

/** The same tripwire as the README's: a page of 300 KB images is slow on a phone. */
const MAX_BYTES = 300 * 1024;

/** Shoots the whole window into `docs-site/public/images/<shot>.png`, `shot` being `<page>/<name>`. */
async function shoot(page: Page, shot: string, options: { mask?: Locator[] } = {}): Promise<void> {
  await captureWindow(page, join(IMAGES_DIR, `${shot}.png`), { ...options, maxBytes: MAX_BYTES });
}

test.describe('docs site screenshots', () => {
  test.skip(
    process.env['WIREBENCH_DOCS_SCREENSHOTS'] !== '1',
    'set WIREBENCH_DOCS_SCREENSHOTS=1 (or run `pnpm docs:screenshots`) to re-shoot the docs site images',
  );

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

  test('getting started: workspace picker', async () => {
    launched = await launchApp();
    await resizeWindow(launched);
    await setTheme(launched.window, 'light');
    await expect(launched.window.getByTestId('workspace-picker')).toBeVisible();
    await shoot(launched.window, 'getting-started/workspace-picker');
  });

  test('getting started: import, request editor and response', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window);
    await createProject(window, 'Calculator Project');
    await openImportDialog(window, 'wsdl');
    await window.getByTestId('import-url-input').fill(server.wsdlUrl);
    await shoot(window, 'getting-started/import-wsdl');

    await window.getByTestId('import-submit').click();
    await expandExplorer(window, 'Request 1');
    await openFirstRequest(window);
    await shoot(window, 'getting-started/request-editor');

    await window.getByTestId('request-send').click();
    await expect(window.getByTestId('response-status')).toContainText(/\d{3}/, { timeout: 20_000 });
    await shoot(window, 'getting-started/response', { mask: timingRegions(window) });
  });

  test('REST client: a request and its response', async () => {
    restServer = await startTestRestServer();
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window, 'Demo');
    await createProject(window, 'Pet Service');
    await createApi(window, 'Petstore', restServer.url);
    await createRestRequest(window, 'Petstore', 'Echo a query');
    await setMethodAndUrl(window, 'GET', '/echo?pet=Fido&limit=10');
    await sendRest(window);
    await expect(window.getByTestId('rest-response-status')).toContainText(/\d{3}/, { timeout: 20_000 });
    await shoot(window, 'rest-client/rest-response', { mask: restTimingRegions(window) });
  });

  test('shared workspaces: sync panel', async () => {
    test.skip(process.platform !== 'darwin', 'the docs screenshots are shot on macOS');
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    remoteDir = remote.dir;
    launched = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createProjectWithCalculator(window, server);
    await saveAll(window);
    await shareWorkspace(window, SHOWN_REMOTE);
    await runCommand(window, 'Sync: Show Sync Panel');
    await expect(window.getByTestId('sync-panel')).toBeVisible();
    await expect(window.getByTestId('sync-log-row').first()).toBeVisible({ timeout: 20_000 });
    await shoot(window, 'workspaces/sync-panel');
  });

  test('shared workspaces: conflict resolver', async () => {
    test.skip(process.platform !== 'darwin', 'the docs screenshots are shot on macOS');
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    remoteDir = remote.dir;

    second = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    await createProjectWithCalculator(second.window, server);
    await saveAll(second.window);
    await shareWorkspace(second.window, SHOWN_REMOTE);

    launched = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');
    await joinSharedWorkspace(window, SHOWN_REMOTE);
    await produceRequestConflict(second.window, window, remote.dir);

    await openConflictResolver(window);
    await shoot(window, 'workspaces/conflict-resolver');
  });
});
