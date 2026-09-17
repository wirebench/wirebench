import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { importProto, openGrpcRequest, placeGreeterProtos, sendGrpc, setMessage } from '../helpers/grpc.js';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProject,
  createProjectWithCalculator,
  createWorkspace,
  dismissChangedOnDiskBanners,
  openFirstRequest,
  workspaceProjectDir,
} from '../helpers/project.js';
import {
  createApi,
  createRestRequest,
  openApiTab,
  openImportOpenApi,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import {
  startTestGrpcServer,
  startTestRestServer,
  startTestSoapServer,
  type TestGrpcServer,
  type TestRestServer,
  type TestSoapServer,
} from '../helpers/test-server.js';

/**
 * Accessibility and theming coverage.
 *
 * Two things live here:
 *
 * 1. An axe-core scan of the workspace picker, the request editor (with a real response) and the interface
 *    viewer, in *both* themes. It fails on `serious` and `critical` violations.
 * 2. Pixel snapshots of the shell in both themes at 1280x800.
 *
 * ## Disabled axe rules
 *
 * `color-contrast` is disabled, and it is the only rule that is. The token palette is gated far
 * more thoroughly by `pnpm contrast:check`, which checks every foreground/surface pair the UI
 * renders in both themes against the token file itself — including pairs that happen not to be
 * on screen during this spec. Axe's own check, by contrast, cannot see through Monaco's
 * canvas-rendered text or a `-webkit-app-region: drag` strip, and reports incomplete results
 * for both, which would make this spec flaky without adding coverage the script does not
 * already give. No other rule is disabled, and none may be without a line in this comment.
 *
 * ## Screenshots
 *
 * Snapshots live under `specs/__screenshots__/{project}-{platform}/` (see
 * `snapshotPathTemplate` in `playwright.config.ts`) and only the macOS set is committed, because
 * that is the only set produced here. Font rasterisation and scrollbar metrics differ per OS, so
 * a Linux or Windows job could only ever compare against snapshots it generated itself — which
 * proves nothing and fails the moment a runner image changes. The two screenshot tests therefore
 * `test.skip` off darwin. They also skip when `CI` is set: `resizeWindow` asks for 1280x800, and
 * a hosted macOS runner's virtual display clamps the window to 1280x677, so a baseline captured
 * at the documented size can never match there. The pixel comparison is a developer-machine
 * check (`pnpm test:e2e` locally, and `docs/success-criteria.md` SC12 records it as such);
 * everything else in this spec still runs on all three CI platforms.
 *
 * Dynamic regions (the app version, clock times, durations, response sizes and `urn:uuid`
 * message ids) are masked so a snapshot never depends on when it was taken.
 */

/** Every rule this spec turns off, with the reason; see the file comment. */
const DISABLED_AXE_RULES = ['color-contrast'];

/** Axe fails the spec at these impact levels; `minor`/`moderate` are reported, not gated. */
const GATED_IMPACTS = new Set(['serious', 'critical']);

/** The window size every scan and every snapshot runs at. */
const VIEWPORT = { width: 1280, height: 800 };

/** Regions whose content changes between runs; masked out of every snapshot. */
function dynamicRegions(page: Page): Locator[] {
  return [
    page.getByTestId('status-bar-save'),
    page.locator('[data-testid="status-bar"] .font-mono'),
    page.locator('[data-testid="http-log-row"]'),
    page.locator('[data-testid="history-row"]'),
  ];
}

/**
 * Runs axe over the whole renderer and asserts nothing serious came back.
 *
 * @param label - Names the page and theme in the failure message.
 */
async function expectNoSeriousViolations(page: Page, label: string): Promise<void> {
  // Legacy mode: axe's default run opens a fresh blank page to aggregate cross-frame partial
  // results, and Electron's renderer target refuses `Target.createTarget`. The renderer has no
  // cross-origin frames, so the single-page run covers exactly the same tree.
  const results = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .disableRules([...DISABLED_AXE_RULES])
    .analyze();
  const serious = results.violations.filter((violation) => GATED_IMPACTS.has(violation.impact ?? ''));
  const summary = serious
    .map((violation) => `${violation.id} (${violation.impact}) x${String(violation.nodes.length)}: ${violation.help}`)
    .join('\n');
  expect(serious, `${label}: axe found serious violations:\n${summary}`).toEqual([]);
}

/** Clicks the status bar's theme indicator until it sits on `preference`. */
async function setTheme(page: Page, preference: 'dark' | 'light' | 'system'): Promise<void> {
  const indicator = page.getByTestId('status-bar-theme');
  await expect(indicator).toBeVisible();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await indicator.getAttribute('data-theme-preference')) === preference) {
      await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/);
      return;
    }
    await indicator.click();
  }
  throw new Error(`the theme indicator never reached ${preference}`);
}

/** Resizes the Electron window itself — a Playwright viewport cannot move a native frame. */
async function resizeWindow(launched: LaunchedApp): Promise<void> {
  await launched.app.evaluate(async ({ BrowserWindow }, size) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.setSize(size.width, size.height);
    // The renderer re-lays out on the resize; give it the frame to do so.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, VIEWPORT);
}

test.describe('accessibility and theming', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let restServer: TestRestServer | undefined;
  let grpcServer: TestGrpcServer | undefined;
  let grpcUserDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (grpcServer) {
      await grpcServer.close();
      grpcServer = undefined;
    }
    // After the app has closed: on Windows the profile folder is locked while it runs.
    if (grpcUserDataDir !== undefined) {
      removeDirSync(grpcUserDataDir);
      grpcUserDataDir = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    if (restServer) {
      await restServer.close();
      restServer = undefined;
    }
  });

  test('theme cycles dark -> light -> system and reaches the document', async () => {
    launched = await launchApp();
    const { window } = launched;
    const indicator = window.getByTestId('status-bar-theme');
    const html = window.locator('html');

    await setTheme(window, 'dark');
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await indicator.click();
    await expect(indicator).toHaveAttribute('data-theme-preference', 'light');
    await expect(html).toHaveAttribute('data-theme', 'light');

    await indicator.click();
    await expect(indicator).toHaveAttribute('data-theme-preference', 'system');
    // `system` resolves against main's `nativeTheme`, so the document must still carry a
    // concrete theme — and the indicator must name the one it resolved to.
    await expect(indicator).toHaveAttribute('data-theme-resolved', /dark|light/);
    const resolved = await indicator.getAttribute('data-theme-resolved');
    await expect(html).toHaveAttribute('data-theme', resolved ?? 'dark');

    await indicator.click();
    await expect(indicator).toHaveAttribute('data-theme-preference', 'dark');
  });

  test('the theme preference survives a relaunch', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-a11y-profile-'));
    try {
      launched = await launchApp({ userDataDir, keepUserDataDir: true });
      await setTheme(launched.window, 'light');
      await launched.close();
      launched = undefined;

      launched = await launchApp({ userDataDir, keepUserDataDir: true });
      await expect(launched.window.getByTestId('status-bar-theme')).toHaveAttribute('data-theme-preference', 'light');
      await expect(launched.window.locator('html')).toHaveAttribute('data-theme', 'light');
      // The profile belongs to a *running* app until this closes it, and Windows refuses to
      // remove a directory anything still holds a handle inside — so close here rather than
      // leaving it to `afterEach`, which runs after this `finally`.
      await launched.close();
      launched = undefined;
    } finally {
      removeDirSync(userDataDir);
    }
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`a11y: the picker has no serious violations (${theme})`, async () => {
      launched = await launchApp();
      await setTheme(launched.window, theme);
      await expect(launched.window.getByTestId('workspace-picker')).toBeVisible();
      await expectNoSeriousViolations(launched.window, `workspace picker (${theme})`);
    });

    test(`a11y: the request editor with a response has no serious violations (${theme})`, async () => {
      server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
      launched = await launchApp();
      const { window } = launched;

      await createProjectWithCalculator(window, server);
      await openFirstRequest(window);
      await window.getByTestId('request-send').click();
      await expect(window.getByTestId('response-status')).toContainText(/\d{3}/, { timeout: 20_000 });

      await setTheme(window, theme);
      await expectNoSeriousViolations(window, `request editor (${theme})`);
    });

    test(`a11y: the REST editor with a response has no serious violations (${theme})`, async () => {
      restServer = await startTestRestServer();
      launched = await launchApp();
      const { window } = launched;

      await createWorkspace(window, 'REST');
      await createProject(window, 'Pets');
      await createApi(window, 'Petstore', restServer.url);
      await createRestRequest(window, 'Petstore', 'Echo');
      await setMethodAndUrl(window, 'GET', '/echo?x=1');
      await sendRest(window);
      await expect(window.getByTestId('rest-response-status')).toContainText(/\d{3}/, { timeout: 20_000 });

      await setTheme(window, theme);
      await expectNoSeriousViolations(window, `REST editor (${theme})`);
    });

    test(`a11y: the gRPC editor with a response has no serious violations (${theme})`, async () => {
      grpcServer = await startTestGrpcServer();
      grpcUserDataDir = mkdtempSync(join(tmpdir(), 'wirebench-a11y-grpc-'));
      launched = await launchApp({ userDataDir: grpcUserDataDir });
      const { window } = launched;

      await createWorkspace(window, 'gRPC');
      await createProject(window, 'Greet');
      await importProto(
        window,
        placeGreeterProtos(workspaceProjectDir(grpcUserDataDir, 'Greet')),
        'Greeter',
        grpcServer.target,
      );
      await openGrpcRequest(window, 'SayHello');
      await setMessage(window, '{"name":"Ada"}');
      await sendGrpc(window);
      await expect(window.getByTestId('grpc-response-status')).toContainText('OK (0)', { timeout: 20_000 });

      await setTheme(window, theme);
      await expectNoSeriousViolations(window, `gRPC editor (${theme})`);
    });

    test(`a11y: the import dialog and the API tab have no serious violations (${theme})`, async () => {
      restServer = await startTestRestServer();
      launched = await launchApp();
      const { window } = launched;

      await createWorkspace(window, 'REST a11y');
      await createProject(window, 'Pets');
      await createApi(window, 'Petstore', restServer.url);

      // The API tab first: it is the surface that carries the auth form and the definition card.
      await openApiTab(window, 'Petstore');
      await setTheme(window, theme);
      await expectNoSeriousViolations(window, `API tab (${theme})`);

      // Then the import dialog, over the same window. Its empty state is the one every user sees
      // first, so it is the state worth gating — a summary needs a document and a live host.
      await openImportOpenApi(window);
      await expectNoSeriousViolations(window, `import OpenAPI dialog (${theme})`);
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('import-openapi-dialog')).toBeHidden();
    });

    test(`a11y: the interface viewer has no serious violations (${theme})`, async () => {
      server = await startTestSoapServer({ fixture: 'calculator' });
      launched = await launchApp();
      const { window } = launched;

      await createProjectWithCalculator(window, server);
      const row = window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Calculator' }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.click({ button: 'right' });
      await window.getByRole('menuitem', { name: 'Show Interface Viewer' }).click();
      await expect(window.getByTestId('interface-editor')).toBeVisible({ timeout: 20_000 });

      await setTheme(window, theme);
      await expectNoSeriousViolations(window, `interface viewer (${theme})`);
    });

    test(`the shell looks right in ${theme}`, async () => {
      test.skip(process.platform !== 'darwin', 'snapshots are macOS-only');
      test.skip(
        !!process.env['CI'],
        'snapshot baselines are captured on developer machines; CI displays clamp the window size',
      );
      server = await startTestSoapServer({ fixture: 'calculator' });
      launched = await launchApp();
      const { window } = launched;
      await resizeWindow(launched);
      await createProjectWithCalculator(window, server);
      await openFirstRequest(window);
      await setTheme(window, theme);
      // The version string only appears once `app.version` resolves; waiting for it keeps the
      // status bar from being half-rendered in the snapshot.
      await expect(window.locator('[data-testid="status-bar"]')).toContainText('TLS');
      await dismissChangedOnDiskBanners(window);

      await expect(window).toHaveScreenshot(`shell-${theme}.png`, {
        mask: dynamicRegions(window),
        maxDiffPixelRatio: 0.002,
        animations: 'disabled',
      });
    });

    test(`the workspace picker looks right in ${theme}`, async () => {
      test.skip(process.platform !== 'darwin', 'snapshots are macOS-only');
      test.skip(
        !!process.env['CI'],
        'snapshot baselines are captured on developer machines; CI displays clamp the window size',
      );
      launched = await launchApp();
      const { window } = launched;
      await resizeWindow(launched);
      await setTheme(window, theme);
      await expect(window.getByTestId('workspace-picker')).toBeVisible();

      await expect(window).toHaveScreenshot(`picker-${theme}.png`, {
        mask: dynamicRegions(window),
        maxDiffPixelRatio: 0.002,
        animations: 'disabled',
      });
    });
  }
});
