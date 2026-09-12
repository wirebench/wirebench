import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest, workspaceProjectDir } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/**
 * Editing a request no longer writes it. The edit is staged, the tab says so, and `Mod+S` is
 * what puts it on disk — so this drives the real app and then reads the request file, because
 * "the dot went away" is not evidence that anything was written.
 */
test.describe('saving the active tab', () => {
  let launched: LaunchedApp;
  let server: TestSoapServer;

  test.beforeAll(async () => {
    server = await startTestSoapServer();
    launched = await launchApp();
    await createProjectWithCalculator(launched.window, server);
    await openFirstRequest(launched.window);
  });

  test.afterAll(async () => {
    await launched.close();
    await server.close();
  });

  /**
   * Every saved request in the project, as they currently stand on disk. Requests live under
   * `interfaces/<slug>/operations/<operation>/<name>.request.yaml`, so this walks to the single
   * `.request.yaml` rather than assuming a flat folder.
   */
  function savedRequestYaml(): string {
    const root = join(workspaceProjectDir(launched.userDataDir), 'interfaces');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (dir.split(sep).includes('operations')) {
          // A request is a `.request.yaml` of metadata plus a sibling `.xml` holding the
          // envelope, so both are collected — the envelope is what this spec edits. Split on
          // the platform's own separator: a literal '/operations/' matches nothing on Windows,
          // where this found no files at all and the spec failed on its own baseline.
          found.push(path);
        }
      }
    };
    walk(root);
    // Every request file in the project, concatenated: the Calculator WSDL yields one per operation,
    // and which one `openFirstRequest` opened is not this spec's business. A marker that is
    // unique to the edit is either somewhere on disk or it is not.
    expect(found.length).toBeGreaterThan(0);
    return found.map((path) => readFileSync(path, 'utf8')).join('\n');
  }

  test('stages an edit, marks the tab, and writes it only on Mod+S', async () => {
    const page = launched.window;
    const dirty = page.getByTestId('editor-tab-dirty');
    const marker = 'StagedEditMarker';

    await expect(dirty).toBeHidden();
    const before = savedRequestYaml();
    expect(before).not.toContain(marker);

    await setMonacoText(page, 'Request envelope XML', `<Envelope><Body><${marker}/></Body></Envelope>`);

    // The tab marks itself immediately...
    await expect(dirty).toBeVisible();
    // ...and nothing writes it on a timer — not the pane's debounce, and not main, where
    // `editor.autosave` is off by default. Waited out rather than checked instantly, so a
    // passing assertion means "still unwritten", not "checked before the write landed".
    await page.waitForTimeout(1_500);
    expect(savedRequestYaml()).not.toContain(marker);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');

    await expect(dirty).toBeHidden();
    await expect.poll(() => savedRequestYaml(), { timeout: 10_000 }).toContain(marker);
  });

  test('Save All writes a staged edit too, rather than a model that never saw it', async () => {
    const page = launched.window;
    const dirty = page.getByTestId('editor-tab-dirty');
    const marker = 'SaveAllMarker';

    await setMonacoText(page, 'Request envelope XML', `<Envelope><Body><${marker}/></Body></Envelope>`);
    await expect(dirty).toBeVisible();
    expect(savedRequestYaml()).not.toContain(marker);

    // Through the palette, which is where Save All is reachable without knowing its chord —
    // and the same command the File menu's item invokes.
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+KeyP`);
    await expect(page.getByTestId('command-palette-input')).toBeVisible({ timeout: 20_000 });
    await page.keyboard.type('Save All');
    await page.keyboard.press('Enter');

    // "Save All" writes main's model. A staged edit that was never committed to main is simply
    // absent from it, so this would report success and leave the edit on the floor.
    await expect(dirty).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => savedRequestYaml(), { timeout: 10_000 }).toContain(marker);
  });
});
