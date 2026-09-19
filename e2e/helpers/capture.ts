import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { ADA } from './git-remote.js';
import type { LaunchedApp } from './launch-app.js';
import { dismissChangedOnDiskBanners } from './project.js';

/**
 * What the screenshot specs share: a fixed window, a chosen theme, masks over wall-clock timings,
 * and one capture routine. The README images (`screenshots.spec.ts`) and the docs site images
 * (`docs-screenshots.spec.ts`) are both written through {@link captureWindow}, so they come out
 * the same size and free of the same passing chrome.
 */

/** Same window size as the theme snapshots: wide enough for the three-pane shell. */
export const VIEWPORT = { width: 1280, height: 800 };

/** Resizes the Electron window itself — a Playwright viewport cannot move a native frame. */
export async function resizeWindow(launched: LaunchedApp): Promise<void> {
  await launched.app.evaluate(async ({ BrowserWindow }, size) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.setSize(size.width, size.height);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, VIEWPORT);
}

/** Clicks the status bar's theme indicator until it sits on `preference`. */
export async function setTheme(page: Page, preference: 'dark' | 'light'): Promise<void> {
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
 * log rows in the console, and the status bar's last-request and last-saved lines — masked out of every capture. Unlike `a11y.spec.ts`'s
 * `dynamicRegions` (masked so a *pixel comparison* never depends on when it ran), these are
 * masked because they are wall-clock numbers off whoever's machine re-shoots the docs: a
 * committed screenshot should not silently vary with — or leak — a maintainer's local timing.
 */
export function timingRegions(page: Page): Locator[] {
  return [
    page.getByTestId('response-status'),
    page.locator('[data-testid="http-log-row"]'),
    page.getByTestId('status-bar-last'),
    page.getByTestId('status-bar-save'),
  ];
}

/** The same, for the REST response pane, whose status line carries its own duration. */
export function restTimingRegions(page: Page): Locator[] {
  return [
    page.getByTestId('rest-response-status'),
    page.locator('[data-testid="http-log-row"]'),
    page.getByTestId('status-bar-last'),
    page.getByTestId('status-bar-save'),
  ];
}

/** The remote the sync captures show: a realistic URL rather than the test remote's temp folder. */
export const SHOWN_REMOTE = 'https://git.example.com/team/wirebench-workspace.git';

/**
 * Git config for a sync capture's profile: Ada's identity plus `url.<test remote>.insteadOf`, so
 * the app is genuinely configured with {@link SHOWN_REMOTE} while git itself talks to the local
 * bare remote. It is the global config the launch points at, never a repository's own, so the
 * app's local-config check has nothing to refuse.
 */
export function shownRemoteEnv(remoteUrl: string): Record<string, string> {
  const file = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-gitconfig-')), 'gitconfig');
  writeFileSync(
    file,
    `[user]\n\tname = ${ADA.name}\n\temail = ${ADA.email}\n[url "${remoteUrl}"]\n\tinsteadOf = ${SHOWN_REMOTE}\n`,
    'utf8',
  );
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
}

/** Shoots the whole window into `file` (a `.png` path) and fails if it is `maxBytes` or heavier. */
export async function captureWindow(
  page: Page,
  file: string,
  options: { readonly mask?: Locator[]; readonly maxBytes: number },
): Promise<void> {
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
  // A mask is painted in the window's own background rather than Playwright's default magenta, so
  // a masked timing reads as an empty field instead of a highlighter stripe across the picture.
  const maskColor = await page.evaluate(() => {
    const dom = globalThis as unknown as {
      document: { body: unknown };
      getComputedStyle(element: unknown): { backgroundColor: string };
    };
    return dom.getComputedStyle(dom.document.body).backgroundColor;
  });
  const buffer = await page.screenshot({
    animations: 'disabled',
    scale: 'css',
    ...(options.mask !== undefined ? { mask: options.mask, maskColor } : {}),
  });
  expect(buffer.byteLength, `${file} is ${String(buffer.byteLength)} bytes; keep screenshots small`).toBeLessThan(
    options.maxBytes,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buffer);
}
