import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import type { TestSoapServer } from './test-server.js';

export interface CreateProjectOptions {
  /** The project to create before importing; defaults to `Calculator Project`. */
  readonly expectProjectName?: string;
}

/**
 * Asserts an explorer row is on screen, scrolling the tree to find it first.
 *
 * react-arborist virtualises the tree: only the rows inside the scroll viewport (plus a row or
 * two of overscan) exist in the DOM at all, so a row far enough down a tall tree is not merely
 * off screen — it is absent, and `toBeVisible` never resolves however long it waits. A second
 * project added under a fully expanded Calculator (24 rows) sits exactly there on any display
 * short enough to clamp the shell, which is every CI runner.
 *
 * So page the list a viewport at a time, wrapping back to the top, until the row mounts. The
 * scroll is left where the row was found: that is the row the caller goes on to use, and
 * putting the list back at the top would unmount it again.
 */
export async function expectExplorerRow(target: Locator, page: Page, timeout = 20_000): Promise<void> {
  const list = page.getByTestId('explorer-tree-scroll');
  await expect(async () => {
    if ((await target.count()) === 0) {
      await list.evaluate((element: { scrollTop: number; clientHeight: number; scrollHeight: number }) => {
        const next = element.scrollTop + element.clientHeight;
        element.scrollTop = next >= element.scrollHeight ? 0 : next;
      });
    }
    await expect(target.first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout });
}

/**
 * Asserts how many projects the workspace holds, by collapsing the tree first.
 *
 * Counting mounted rows is only meaningful when every project row can be mounted at once, and
 * a single expanded project is enough to push the others out of the virtualised window (see
 * {@link expectExplorerRow}). *Collapse all* is the explorer's own answer to that: it leaves
 * exactly one row per project, which fits on any display.
 */
export async function expectProjectCount(page: Page, count: number): Promise<void> {
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.getByTestId('explorer-project-row')).toHaveCount(count, { timeout: 20_000 });
}

/**
 * Creates a workspace from the picker (the name field, then Enter) and waits for the IDE.
 * Expects the picker to be showing, i.e. a fresh profile or no workspace open.
 */
export async function createWorkspace(page: Page, name = 'Workspace 1'): Promise<void> {
  const field = page.getByTestId('workspace-create-name');
  await expect(field).toBeVisible({ timeout: 20_000 });
  await field.fill(name);
  await page.getByTestId('workspace-create').click();
  await expect(page.getByTestId('activity-bar')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('title-bar')).toContainText(name);
}

/**
 * Creates a project by name through the explorer toolbar's New Project button and waits for
 * its explorer row. The new project is left selected, so the next Import WSDL lands in it.
 */
export async function createProject(page: Page, name: string): Promise<void> {
  await page.getByTestId('explorer-new-project').click();
  await expect(page.getByTestId('new-project-dialog')).toBeVisible();
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('new-project-create').click();
  await expect(page.getByTestId('new-project-dialog')).toBeHidden();
  await expectExplorerRow(page.getByTestId('explorer-project-row').filter({ hasText: name }), page);
}

/** Imports `server`'s WSDL through the explorer toolbar into the selected project. */
export async function importCalculator(page: Page, server: TestSoapServer): Promise<void> {
  await page.getByRole('button', { name: 'Import WSDL…' }).click();
  await page.getByTestId('import-url-input').fill(server.wsdlUrl);
  await page.getByTestId('import-submit').click();
  await expandExplorer(page, 'Request 1');
}

/**
 * Unfolds the whole explorer tree — an imported interface arrives folded shut — and waits for a
 * row reading `rowText` to show. Waits for the import dialog to close first, since the tree it
 * unfolds is only complete once the import has landed.
 */
export async function expandExplorer(page: Page, rowText: string): Promise<void> {
  await expect(page.getByTestId('import-submit')).toBeHidden({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(page.locator('[data-testid="explorer-tree-row"]', { hasText: rowText }).first()).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * A workspace holding one project (`Calculator Project` unless `expectProjectName` says
 * otherwise) with `server`'s WSDL imported, returning once `Request 1` is in the explorer.
 */
export async function createProjectWithCalculator(
  page: Page,
  server: TestSoapServer,
  options: CreateProjectOptions = {},
): Promise<void> {
  await createWorkspace(page);
  await createProject(page, options.expectProjectName ?? 'Calculator Project');
  await importCalculator(page, server);
}

/**
 * The folder of a project inside the profile's workspaces:
 * `<userDataDir>/workspaces/<id>/projects/<slug>`. With no `slug`, the profile must hold
 * exactly one project (every spec that looks at files creates just one).
 */
export function workspaceProjectDir(userDataDir: string, slug?: string): string {
  const root = join(userDataDir, 'workspaces');
  const found: string[] = [];
  for (const workspace of existsSync(root) ? readdirSync(root) : []) {
    const projects = join(root, workspace, 'projects');
    for (const project of existsSync(projects) ? readdirSync(projects) : []) {
      if (slug === undefined || project === slug) {
        found.push(join(projects, project));
      }
    }
  }
  if (found.length !== 1) {
    throw new Error(
      `expected one project folder under ${root}${slug === undefined ? '' : ` named ${slug}`}, found ${String(found.length)}`,
    );
  }
  return found[0] as string;
}

/**
 * Every crafted fixture's `wsdl:service` name — what the explorer shows for it after import
 * (`toInterfaceSummary` falls back to `definition.services[0].name.localName`), keyed by the
 * fixture id a spec passes to `startTestSoapServer({ fixture })`.
 */
const FIXTURE_INTERFACE_NAMES: Readonly<Record<string, string>> = {
  'ws-addressing': 'WsAddressingService',
};

/**
 * The same flow as {@link createProjectWithCalculator}, for a server started with a different
 * `fixture`. The fixture is chosen when the server starts (`startTestSoapServer({ fixture })`),
 * so this can't *select* the fixture by `name` — what is imported is whatever `server.wsdlUrl`
 * serves. What it can (and must) do is check that the server actually served the fixture the
 * spec asked for, by asserting the explorer shows that fixture's interface name once the import
 * settles, instead of silently accepting whatever came back.
 */
export async function createProjectWithFixture(
  page: Page,
  server: TestSoapServer,
  name: string,
  options: CreateProjectOptions = {},
): Promise<void> {
  await createProjectWithCalculator(page, server, options);
  const interfaceName = FIXTURE_INTERFACE_NAMES[name];
  if (interfaceName !== undefined) {
    await expectExplorerRow(page.locator('[data-testid="explorer-tree-row"]', { hasText: interfaceName }), page);
  }
}

/** Opens the first `Request 1` in the explorer through its context menu (react-arborist owns double-click). */
export async function openFirstRequest(page: Page): Promise<void> {
  const row = page.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // A single click opens it; the context menu no longer carries an *Open* that says so twice.
  await row.click();
  await expect(page.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });
}

/**
 * After a relaunch on the same profile: the last workspace reopens by itself, IDE and all.
 * There is nothing to click — that is the behaviour under test. The sidebar is wherever the
 * previous session left it, so this asserts the shell and the title bar, not the explorer.
 */
export async function expectReopenedWorkspace(page: Page, workspaceName = 'Workspace 1'): Promise<void> {
  await expect(page.getByTestId('activity-bar')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('workspace-picker')).toHaveCount(0);
  await expect(page.getByTestId('title-bar')).toContainText(workspaceName, { timeout: 20_000 });
}

/**
 * Opens a request through quick-open (⌘P), narrowed by `query`.
 *
 * With two projects open, every project has a `Request 1` of its own and the explorer cannot
 * say which row is whose — the labels are identical and the tree is virtualised. Quick-open
 * can: every row names the project and interface it belongs to (`quickOpenEntries`), so a
 * query naming one of those picks a request out of exactly one project. Landing on an
 * operation that has no request yet opens its first one, which is the same outcome.
 */
export async function openRequestByQuickOpen(page: Page, query: string): Promise<void> {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+KeyP`);
  await expect(page.getByTestId('quick-open-input')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.type(query);
  const item = page.getByTestId('quick-open-item').first();
  await expect(item).toBeVisible({ timeout: 20_000 });
  await expect(item).toContainText(query.split(' ')[0] ?? query);
  await item.click();
  await expect(page.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });
}

/**
 * Writes every open project to disk and waits for the write to land.
 *
 * Saving is manual unless the user turns autosave on, so a spec that reads the project folder
 * mid-session has to say when the files should exist — otherwise it is asserting against a
 * folder the app has deliberately not written to yet. Driven through the palette rather than
 * the ⌘S chord: the chord is rebindable (one spec rebinds a different one and relaunches), and
 * the palette entry is the same command either way.
 */
export async function saveAll(page: Page): Promise<void> {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+KeyP`);
  await expect(page.getByTestId('command-palette-input')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.type('Save All');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette-input')).toHaveCount(0);
  // Wait for nothing to be dirty any more, across every open project — not for the status strip
  // to say "Saved". That label is `Saved <clock>` and survives until the next write, so after any
  // earlier save it already matches and this assertion would pass before the Save All had
  // finished, leaving a caller free to read a half-written project folder.
  await expect(page.getByTestId('title-bar-dirty')).toHaveCount(0, { timeout: 20_000 });
}
