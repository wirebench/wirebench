import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import {
  consoleHeight,
  doubleClickHandle,
  dragHandle,
  expectSidebarCollapsed,
  expectSidebarVisible,
  sidebarWidth,
  stepHandle,
} from '../helpers/layout.js';

/** The platform's `Mod`: ⌘ on macOS, Ctrl elsewhere — matches `lib/keybindings.ts`. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Reopens the sidebar on Explorer through the activity bar — the "reopens a collapsed sidebar" path. */
async function reopenSidebarFromActivityBar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Explorer' }).click();
}

test.describe('layout: collapsible, resizable panels', () => {
  let launched: LaunchedApp | undefined;
  let userDataDir = '';

  test.beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-layout-'));
  });

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (userDataDir.length > 0) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    userDataDir = '';
  });

  test('dragging the sidebar handle past its minimum collapses it, and the activity bar stays', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);
    await expectSidebarVisible(page);

    await dragHandle(page, 'panel-handle-sidebar', -300, 0);

    await expectSidebarCollapsed(page);
  });

  test('the activity bar reopens a collapsed sidebar', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);

    await dragHandle(page, 'panel-handle-sidebar', -300, 0);
    await expectSidebarCollapsed(page);

    await reopenSidebarFromActivityBar(page);

    await expectSidebarVisible(page);
  });

  test('dragging the console handle past its minimum collapses it', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);
    await expect(page.getByTestId('console-panel')).toBeVisible();

    await dragHandle(page, 'panel-handle-console', 0, 400);

    await expect(page.getByTestId('console-panel')).toHaveCount(0);
    // Collapsing the console must not take the editor area down with it.
    await expect(page.getByTestId('editor-area')).toBeVisible();
  });

  test('double-clicking the sidebar handle collapses it, and double-clicking it again restores its size', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);

    // Drag first, so the size the second double-click restores is provably the sidebar's own
    // last size — not just whatever it happened to start at.
    await dragHandle(page, 'panel-handle-sidebar', 100, 0);
    const widened = await sidebarWidth(page);
    expect(widened).toBeDefined();

    await doubleClickHandle(page, 'panel-handle-sidebar');
    // Collapsing must be visible, not just a store flag: the panel itself unmounts and the
    // handle's own label switches to name the "restore" it now performs.
    await expectSidebarCollapsed(page);
    await expect(page.getByTestId('panel-handle-sidebar')).toHaveAttribute('aria-label', 'Show Sidebar');

    await doubleClickHandle(page, 'panel-handle-sidebar');

    await expectSidebarVisible(page);
    await expect(page.getByTestId('panel-handle-sidebar')).toHaveAttribute('aria-label', 'Resize Sidebar');
    const restored = await sidebarWidth(page);
    expect(restored).toBeDefined();
    expect(Math.abs(restored! - widened!)).toBeLessThan(3);
  });

  test('double-clicking the console handle collapses it, and double-clicking it again restores its size', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);

    // Dragging up grows the console (the handle sits above it).
    await dragHandle(page, 'panel-handle-console', 0, -80);
    const grown = await consoleHeight(page);
    expect(grown).toBeDefined();

    await doubleClickHandle(page, 'panel-handle-console');
    await expect(page.getByTestId('console-panel')).toHaveCount(0);
    await expect(page.getByTestId('editor-area')).toBeVisible();
    await expect(page.getByTestId('panel-handle-console')).toHaveAttribute('aria-label', 'Show Console');

    await doubleClickHandle(page, 'panel-handle-console');

    await expect(page.getByTestId('console-panel')).toBeVisible();
    await expect(page.getByTestId('panel-handle-console')).toHaveAttribute('aria-label', 'Resize Console');
    const restored = await consoleHeight(page);
    expect(restored).toBeDefined();
    expect(Math.abs(restored! - grown!)).toBeLessThan(3);
  });

  test('double-clicking a handle still works after the panel it belongs to was never manually resized', async () => {
    // Finding 1's actual bug: a collapsed panel's handle unmounted along with the panel, so there
    // was no way at all to double-click-expand it. This proves the round trip from a completely
    // untouched (default-size) panel — collapse, then restore — needs no prior drag to work.
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);

    const defaultWidth = await sidebarWidth(page);
    expect(defaultWidth).toBeDefined();

    await doubleClickHandle(page, 'panel-handle-sidebar');
    await expectSidebarCollapsed(page);

    await doubleClickHandle(page, 'panel-handle-sidebar');
    await expectSidebarVisible(page);
    const restored = await sidebarWidth(page);
    expect(restored).toBeDefined();
    expect(Math.abs(restored! - defaultWidth!)).toBeLessThan(3);
  });

  test('arrow keys resize the sidebar in 2% steps while the handle has focus', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);

    const before = await sidebarWidth(page);
    expect(before).toBeDefined();

    await stepHandle(page, 'panel-handle-sidebar', 'ArrowRight', 3);
    const widened = await sidebarWidth(page);
    expect(widened).toBeDefined();
    expect(widened! - before!).toBeGreaterThan(20);

    await stepHandle(page, 'panel-handle-sidebar', 'ArrowLeft', 3);
    const back = await sidebarWidth(page);
    expect(back).toBeDefined();
    expect(Math.abs(back! - before!)).toBeLessThan(3);
  });

  test('the sidebar header button, the status bar button, and Mod+B all collapse and reopen it', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);

    await page.getByTestId('sidebar-collapse').click();
    await expectSidebarCollapsed(page);
    await expect(page.getByTestId('status-bar-sidebar')).toHaveAttribute('aria-pressed', 'false');

    await page.getByTestId('status-bar-sidebar').click();
    await expectSidebarVisible(page);
    await expect(page.getByTestId('status-bar-sidebar')).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press(`${MOD}+KeyB`);
    await expectSidebarCollapsed(page);

    await page.keyboard.press(`${MOD}+KeyB`);
    await expectSidebarVisible(page);
  });

  test('the console header button, the status bar button, and Mod+J all collapse and reopen it', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);

    await page.getByTestId('console-collapse').click();
    await expect(page.getByTestId('console-panel')).toHaveCount(0);
    await expect(page.getByTestId('status-bar-console')).toHaveAttribute('aria-pressed', 'false');

    await page.getByTestId('status-bar-console').click();
    await expect(page.getByTestId('console-panel')).toBeVisible();
    await expect(page.getByTestId('status-bar-console')).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press(`${MOD}+KeyJ`);
    await expect(page.getByTestId('console-panel')).toHaveCount(0);

    await page.keyboard.press(`${MOD}+KeyJ`);
    await expect(page.getByTestId('console-panel')).toBeVisible();
  });

  test('opening the Code slide-over does not shift the editor area', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page);

    const editor = page.getByTestId('editor-area');
    await expect(editor).toBeVisible();
    const before = await editor.boundingBox();
    expect(before).not.toBeNull();

    await page.getByTestId('rail-code').click();
    await expect(page.getByTestId('slide-over')).toBeVisible();

    const after = await editor.boundingBox();
    expect(after).not.toBeNull();
    expect(after).toEqual(before);
  });

  test('a relaunch restores collapsed states and sizes', async () => {
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    await createWorkspace(page);

    // Collapse the sidebar, and resize (without collapsing) the console.
    await dragHandle(page, 'panel-handle-sidebar', -300, 0);
    await expectSidebarCollapsed(page);
    const consoleBefore = await consoleHeight(page);
    expect(consoleBefore).toBeDefined();
    await dragHandle(page, 'panel-handle-console', 0, -80);
    const consoleResized = await consoleHeight(page);
    expect(consoleResized).toBeDefined();
    expect(consoleResized! - consoleBefore!).toBeGreaterThan(40);

    await launched.close();
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;

    await expectSidebarCollapsed(page);
    const consoleAfterRelaunch = await consoleHeight(page);
    expect(consoleAfterRelaunch).toBeDefined();
    expect(Math.abs(consoleAfterRelaunch! - consoleResized!)).toBeLessThan(3);
  });

  test('a relaunch restores the other combination too: a resized sidebar and a collapsed console', async () => {
    // The first persistence test only ever covered a *collapsed* sidebar and a *resized* console;
    // this covers the two cases it left out, so both panels' collapsed and resized states are each
    // proven to survive a relaunch at least once.
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    await createWorkspace(page);

    const sidebarBefore = await sidebarWidth(page);
    expect(sidebarBefore).toBeDefined();
    await dragHandle(page, 'panel-handle-sidebar', 60, 0);
    const sidebarResized = await sidebarWidth(page);
    expect(sidebarResized).toBeDefined();
    expect(sidebarResized! - sidebarBefore!).toBeGreaterThan(30);

    await dragHandle(page, 'panel-handle-console', 0, 400); // past its minimum: collapses it
    await expect(page.getByTestId('console-panel')).toHaveCount(0);
    await expect(page.getByTestId('editor-area')).toBeVisible();

    await launched.close();
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;

    await expectSidebarVisible(page);
    const sidebarAfterRelaunch = await sidebarWidth(page);
    expect(sidebarAfterRelaunch).toBeDefined();
    expect(Math.abs(sidebarAfterRelaunch! - sidebarResized!)).toBeLessThan(3);
    await expect(page.getByTestId('console-panel')).toHaveCount(0);
  });
});
