/**
 * The app's user-visible performance budgets.
 *
 * Four things are measured here, all of them things a user feels rather than things a
 * micro-benchmark would catch: how long the window takes to become usable, whether scrolling a
 * large response stays at 60 fps, whether the derived views over that same response appear
 * promptly, and how long the Problems panel takes to show what validating it found.
 *
 * Budgets are per-platform (`BUDGETS` below): a Linux CI runner under xvfb has no GPU and
 * starts an Electron window appreciably slower than a developer's machine, so holding it to a
 * macOS number would only teach people to ignore a red build. Set `WIREBENCH_SKIP_PERF=1` to
 * skip the file, matching the engine's own perf gate.
 *
 * Each measurement takes the median of several samples so one descheduled frame — or one cold
 * disk read — cannot fail the run on its own.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** Per-platform budgets in milliseconds. */
interface PlatformBudgets {
  /**
   * Launching the app: measured from before `_electron.launch`, so it covers spawning the
   * Electron process, the main process's own start-up and the first window painting its shell —
   * everything between the user's double-click and a usable window.
   */
  readonly startupMs: number;
  /**
   * Median gap between animation frames during a scripted scroll of a 1 MB response. This is the
   * time the renderer spends doing rAF work, not a vsync-locked frame budget: an idle display
   * paces callbacks at ~16.7 ms, so the number is only meaningful as an upper bound — 20 ms says
   * Monaco's re-render of the newly revealed lines is not dominating the frame.
   */
  readonly frameMs: number;
  /** Switching to the Outline or Query view over that same 1 MB document. */
  readonly viewMs: number;
  /** Validating that 1 MB response and having the Problems panel on screen with its rows. */
  readonly problemsMs: number;
}

/**
 * Linux CI runs headless under xvfb with software rendering, which roughly doubles both window
 * creation and frame times; the brief's budgets are 2 s of startup on macOS and 4 s there.
 */
const BUDGETS: PlatformBudgets =
  process.platform === 'linux'
    ? { startupMs: 4000, frameMs: 40, viewMs: 2000, problemsMs: 2000 }
    : { startupMs: 2000, frameMs: 20, viewMs: 1000, problemsMs: 1000 };

/** Skipped only by `WIREBENCH_SKIP_PERF=1`, the documented escape hatch for slow machines. */
const SKIP_PERF = process.env['WIREBENCH_SKIP_PERF'] === '1';

/** The median of a non-empty sample list. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

test.describe('performance budgets', () => {
  test.skip(SKIP_PERF, 'WIREBENCH_SKIP_PERF=1');

  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  const tempDirs: string[] = [];

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`the window is usable within ${BUDGETS.startupMs} ms`, async () => {
    // Three launches, median taken: the very first one also pays for the OS warming the app
    // bundle's pages, which is not what this budget is about. The clock starts before
    // `launchApp`, so the Electron process spawn is inside the budget.
    const samples: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = Date.now();
      const app = await launchApp();
      // `launchApp` already awaits `firstWindow()` and the activity bar, so by the time it
      // returns the window is showing the shell — which is exactly the budgeted moment.
      samples.push(Date.now() - started);
      await app.close();
    }
    const value = median(samples);
    console.info(`[perf] startup: median ${value.toFixed(0)} ms (budget ${BUDGETS.startupMs} ms)`);
    expect(value, `samples: ${samples.map((s) => s.toFixed(0)).join(', ')} ms`).toBeLessThan(BUDGETS.startupMs);
  });

  test(`a 1 MB response scrolls at ${(1000 / BUDGETS.frameMs).toFixed(0)} fps and its views render promptly`, async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    const userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    tempDirs.push(userDataDir);

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server);
    await openFirstRequest(page);

    // `/big-soap/1` answers with a well-formed ~1 MB SOAP envelope, so the response lands in
    // the XML editor (and the Outline/Query views) rather than the non-SOAP `<pre>` fallback.
    await page.getByTestId('request-endpoint').fill(`${server.url}/big-soap/1`);
    await page.getByTestId('request-send').click();

    const responseEditor = page.getByTestId('response-editor');
    await expect(responseEditor).toBeVisible({ timeout: 30_000 });
    // Wait for the model itself rather than for rendered lines: Monaco virtualises the view, so
    // only the first screenful of a 1 MB document is ever in the DOM.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const monaco = (
              globalThis as unknown as { __wirebenchMonaco?: { editor: { getModels(): { getValue(): string }[] } } }
            ).__wirebenchMonaco;
            return monaco === undefined
              ? 0
              : Math.max(0, ...monaco.editor.getModels().map((model) => model.getValue().length));
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(900_000);

    // Scroll the response editor's own scrollable element through the document, sampling the
    // gap between animation frames. Each step is applied inside a rAF callback so the numbers
    // include Monaco's re-render of the newly revealed lines, which is the cost being budgeted.
    const frameTimes: number[] = await page.evaluate(async () => {
      // The e2e project compiles against `@types/node` only, deliberately: a spec's own code
      // runs in Node and must not reach for browser globals by accident. The body of an
      // `evaluate` callback is the exception — it runs in the renderer — so the handful of DOM
      // globals it needs are reached through one explicit cast, as `helpers/editor.ts` does for
      // the Monaco handle.
      const browser = globalThis as unknown as {
        document: { querySelectorAll(selector: string): ArrayLike<{ scrollTop: number }> };
        requestAnimationFrame(callback: (now: number) => void): number;
      };
      const scrollables = browser.document.querySelectorAll(
        '[data-testid="response-editor"] .monaco-scrollable-element',
      );
      const target = scrollables[scrollables.length - 1];
      if (target === undefined) {
        throw new Error('no scrollable element inside the response editor');
      }
      const nextFrame = async (): Promise<number> =>
        new Promise<number>((resolve) => browser.requestAnimationFrame(resolve));

      const frames: number[] = [];
      // Warm-up frame so the first sample does not include the initial paint.
      let previous = await nextFrame();
      for (let step = 0; step < 60; step += 1) {
        target.scrollTop += 400;
        const now = await nextFrame();
        frames.push(now - previous);
        previous = now;
      }
      return frames;
    });

    const frameMedian = median(frameTimes);
    console.info(
      `[perf] scroll: median frame ${frameMedian.toFixed(1)} ms over ${frameTimes.length} frames ` +
        `(budget ${BUDGETS.frameMs} ms = ${(1000 / BUDGETS.frameMs).toFixed(0)} fps)`,
    );
    expect(frameMedian).toBeLessThan(BUDGETS.frameMs);

    // The derived views over the same 1 MB document: each must appear within the budget.
    const outlineStarted = Date.now();
    await page.getByRole('tablist', { name: 'Response views' }).getByRole('tab', { name: 'Outline' }).click();
    await expect(page.getByRole('tree', { name: 'Response outline' })).toBeVisible({ timeout: 30_000 });
    const outlineMs = Date.now() - outlineStarted;
    console.info(`[perf] outline over 1 MB: ${outlineMs} ms (budget ${BUDGETS.viewMs} ms)`);
    expect(outlineMs).toBeLessThan(BUDGETS.viewMs);

    const queryStarted = Date.now();
    await page.getByRole('tablist', { name: 'Response views' }).getByRole('tab', { name: 'Query' }).click();
    await expect(page.getByTestId('query-run')).toBeVisible({ timeout: 30_000 });
    const queryMs = Date.now() - queryStarted;
    console.info(`[perf] query view over 1 MB: ${queryMs} ms (budget ${BUDGETS.viewMs} ms)`);
    expect(queryMs).toBeLessThan(BUDGETS.viewMs);

    // Validating that same 1 MB response: the budget covers the whole round trip a user waits
    // through — the schema validation in the main process, and the Problems panel opening with
    // its rows rendered. The `/big-soap` envelope is not what the Calculator schema describes,
    // so validation has real findings to list rather than an empty panel.
    const problemsStarted = Date.now();
    await page.getByTestId('request-pane-surface').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Validate response' }).click();
    // The panel does not open itself; showing it is part of what the user waits through.
    await page.getByTestId('status-bar-problems').click();
    await expect(page.getByRole('grid', { name: 'Problems' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('problem-row').first()).toBeVisible({ timeout: 30_000 });
    const problemsMs = Date.now() - problemsStarted;
    console.info(`[perf] problems over 1 MB: ${problemsMs} ms (budget ${BUDGETS.problemsMs} ms)`);
    expect(problemsMs).toBeLessThan(BUDGETS.problemsMs);
  });
});
