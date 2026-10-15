import { expect, test, type Page } from '@playwright/test';
import { launchApp, SHELL_READY_SELECTOR, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import {
  addHeader,
  createApi,
  createRestRequest,
  openRequestTab,
  openResponseTab,
  responseStatus,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

/** The window sizes the REST editor has to fit without scrolling sideways. */
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
] as const;

/**
 * Sets the window's content area — what the renderer lays out in — to `size`. Returns false when
 * the screen is too small to give it (a hosted macOS runner's is), so the spec can skip that size.
 */
async function setWindowSize(launched: LaunchedApp, size: { width: number; height: number }): Promise<boolean> {
  return launched.app.evaluate(async ({ BrowserWindow }, next) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.setContentSize(next.width, next.height);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [width, height] = window?.getContentSize() ?? [0, 0];
    return width === next.width && height === next.height;
  }, size);
}

/**
 * Every element in the REST editor that scrolls sideways, or reaches past the window's right edge.
 * An element that clips (`overflow: hidden`) does not count: Monaco keeps its own scrollbars.
 */
async function sidewaysOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const editor = document.querySelector('[data-testid="rest-editor"]');
    if (editor === null) {
      return ['no REST editor'];
    }
    const found: string[] = [];
    const describe = (element: Element): string =>
      `${element.tagName.toLowerCase()}${element.getAttribute('data-testid') !== null ? `[${element.getAttribute('data-testid') ?? ''}]` : ''}${element.getAttribute('aria-label') !== null ? `(${element.getAttribute('aria-label') ?? ''})` : ''}`;
    if (editor.getBoundingClientRect().right > window.innerWidth + 1) {
      found.push(`${describe(editor)} ends past the window`);
    }
    for (const element of [editor, ...Array.from(editor.querySelectorAll('*'))]) {
      if (!(element instanceof HTMLElement) || element.closest('.monaco-editor') !== null) {
        continue;
      }
      const overflowX = getComputedStyle(element).overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && element.scrollWidth > element.clientWidth + 1) {
        found.push(`${describe(element)} scrolls ${String(element.scrollWidth)} in ${String(element.clientWidth)}`);
      }
    }
    return found;
  });
}

test.describe('REST editor at small window sizes', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    await server?.close();
    launched = undefined;
    server = undefined;
  });

  test('fits at 1440×900 and 1024×700, with the code panel open or closed', async () => {
    server = await startTestRestServer();
    launched = await launchApp({ adaptiveLayout: true });
    const page = launched.window;

    await createWorkspace(page, 'Layout');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo?x=1');
    await addHeader(page, 'X-Trace', 'abc');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200', { timeout: 20_000 });

    const [wide] = SIZES;
    test.skip(!(await setWindowSize(launched, wide)), 'The screen is smaller than 1440×900');
    for (const size of SIZES) {
      for (const codePanel of [false, true]) {
        const where = `${String(size.width)}×${String(size.height)}, code panel ${codePanel ? 'open' : 'closed'}`;
        await setWindowSize(launched, size);
        const codeOpen = await page.getByTestId('code-panel').isVisible();
        if (codeOpen !== codePanel) {
          await page.getByTestId('rail-code').click();
        }
        await expect(page.getByTestId('code-panel')).toBeVisible({ visible: codePanel });

        // The tabs that used to push the pane sideways, each picked from wherever it now sits.
        for (const tab of ['Assertions', 'Snapshot', 'Body']) {
          await openResponseTab(page, tab);
          await expect(responseStatus(page), where).toBeInViewport();
          expect(await sidewaysOverflow(page), `${where}, ${tab} tab`).toEqual([]);
        }
        await openRequestTab(page, 'Headers');
        await expect(page.getByTestId('rest-generated-headers')).toBeVisible();
        expect(await sidewaysOverflow(page), `${where}, request Headers tab`).toEqual([]);
        await openRequestTab(page, 'Params');
      }
    }

    // At 1024 wide there is not room for two panes side by side, so the response goes underneath.
    await expect(page.getByTestId('rest-editor')).toHaveAttribute('data-orientation', 'vertical');
    await setWindowSize(launched, wide);
    await page.getByTestId('rail-code').click();
    await expect(page.getByTestId('code-panel')).toBeHidden();
    await expect(page.getByTestId('rest-editor')).toHaveAttribute('data-orientation', 'horizontal');
  });

  test('a short window starts with the console collapsed', async () => {
    launched = await launchApp({ adaptiveLayout: true });
    const page = launched.window;
    await createWorkspace(page, 'Short');
    // A runner whose screen already clamps the window below the threshold starts collapsed too.
    if ((await page.evaluate(() => window.innerHeight)) >= 720) {
      await expect(page.getByTestId('console')).toBeVisible();
    }

    test.skip(!(await setWindowSize(launched, SIZES[1])), 'The screen is smaller than 1024×700');
    await page.reload();
    await page.waitForSelector(SHELL_READY_SELECTOR);
    await expect(page.getByTestId('activity-bar')).toBeVisible();
    await expect(page.getByTestId('console')).toBeHidden();
  });
});
