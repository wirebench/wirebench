/**
 * The workspace as a user actually lives in it, end to end.
 *
 * Two tests rather than one: the flow the milestone describes runs from an empty picker to a
 * deleted workspace, and squeezing it into a single `test` would put a relaunch, two servers,
 * a folder export and three dialogs inside one 60 s budget — and leave a failure anywhere in
 * it impossible to read. The split is by subject, not by convenience:
 *
 *  1. *A workspace holds several projects* — two projects side by side, a tab open on each,
 *     a workspace environment that redirects one of them, and the whole thing coming back
 *     after a relaunch and after switching to another workspace and back.
 *  2. *A project moves between workspaces* — removing an internal project (its folder to the
 *     trash), exporting the other one, linking that export into a second workspace, being
 *     refused when linking it twice, and deleting the first workspace from *Manage workspaces*.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProject,
  createWorkspace,
  expectReopenedWorkspace,
  importCalculator,
  openFirstRequest,
  openRequestByQuickOpen,
} from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** The editor tabs, Start included — the shell's own tablist, not a response-view one. */
function editorTabs(page: Page) {
  return page.getByRole('tablist', { name: 'Open editors' }).getByRole('tab');
}

/** POSTs a fixture server has received — what "the send went here" is measured by. */
function posts(server: TestSoapServer): number {
  return server.requests.filter((request) => request.method === 'POST').length;
}

/** Sends the request in the open editor and waits for its response status. */
async function send(page: Page): Promise<void> {
  await page.getByTestId('request-send').click();
  await expect(page.getByTestId('response-status')).toContainText(/200/, { timeout: 20_000 });
}

test.describe('workspaces', () => {
  let launched: LaunchedApp | undefined;
  const servers: TestSoapServer[] = [];
  let userDataDir: string | undefined;
  const tempDirs: string[] = [];

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    for (const server of servers.splice(0)) {
      await server.close();
    }
    for (const dir of [...(userDataDir === undefined ? [] : [userDataDir]), ...tempDirs.splice(0)]) {
      rmSync(dir, { recursive: true, force: true });
    }
    userDataDir = undefined;
  });

  /** A throwaway directory, removed in `afterEach`. */
  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  test('two projects share a workspace, its environment redirects one, and both survive a relaunch', async () => {
    // Three deployments: the Calculator WSDL is imported from `imported`, the `dev` environment
    // points the Calculator interface at `deployed`, and the second project's interface comes
    // from `addressing` — a different fixture, so the two projects are told apart by name.
    const imported = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    const deployed = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    const addressing = await startTestSoapServer({ fixture: 'ws-addressing' });
    servers.push(imported, deployed, addressing);
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    await expect(page.getByTestId('workspace-picker')).toBeVisible();

    // --- a workspace, a project, and the Calculator imported into it --------------------
    await createWorkspace(page);
    await createProject(page, 'Calculator Project');
    await importCalculator(page, imported);

    // --- the second fixture, imported as a project of its own ---------------------------
    // The dialog's *Into project* picker is the only place that choice is made; its
    // `New project` option is the empty value.
    await page.getByRole('button', { name: 'Import WSDL…' }).click();
    await page.getByTestId('import-url-input').fill(addressing.wsdlUrl);
    await page.getByTestId('import-target-project').selectOption('');
    await page.getByTestId('import-submit').click();
    await expect(
      page.locator('[data-testid="explorer-tree-row"]', { hasText: 'WsAddressingService' }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('explorer-project-row')).toHaveCount(2);

    // --- a tab on a request from each project, and a send from each ---------------------
    await openRequestByQuickOpen(page, 'Calculator Project');
    await send(page);
    await openRequestByQuickOpen(page, 'WsAddressingService');
    await send(page);
    // Start, plus one tab per project.
    await expect(editorTabs(page)).toHaveCount(3);
    expect(posts(imported)).toBe(1);
    expect(posts(addressing)).toBe(1);

    // --- a `dev` workspace environment overriding the Calculator interface --------------
    await page.getByRole('button', { name: 'Add environment' }).click();
    await page.getByLabel('New environment name').fill('dev');
    await page.getByLabel('New environment name').press('Enter');
    const devRow = page.getByTestId('environment-row').filter({ hasText: 'dev' });
    await expect(devRow).toBeVisible();

    // Double-click opens the workspace environment grid: one row per interface of every open
    // project, one column per environment.
    await devRow.dblclick();
    await expect(page.getByTestId('workspace-env-grid')).toBeVisible({ timeout: 20_000 });
    const override = page.getByLabel(/^Endpoint override for Calculator Project .* Calculator in dev$/);
    await expect(override).toBeVisible({ timeout: 20_000 });
    await override.fill(`${deployed.url}/soap`);
    await override.press('Enter');
    // The override is the layer that wins for this interface in this environment.
    await expect(page.locator('[data-testid="workspace-env-cell"][data-source="workspace"]').first()).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId('env-switcher').click();
    await page.getByRole('menuitem', { name: 'dev', exact: true }).click();
    await expect(page.getByTestId('env-switcher')).toContainText('dev');

    // --- the Calculator tab's send now goes to the second server, and only there ---------
    const importedBefore = posts(imported);
    const addressingBefore = posts(addressing);
    await editorTabs(page).nth(1).click();
    await expect(page.getByTestId('endpoint-env-badge')).toBeVisible({ timeout: 20_000 });
    await send(page);
    expect(posts(deployed)).toBe(1);
    expect(posts(imported)).toBe(importedBefore);
    expect(posts(addressing)).toBe(addressingBefore);

    // --- relaunch: the workspace reopens by itself, with both tabs ----------------------
    await launched.close();
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    page = launched.window;
    await expectReopenedWorkspace(page);
    // Start, the two requests, and the environment grid the `dev` row opened — every tab kind
    // that names a durable entity comes back.
    await expect(editorTabs(page)).toHaveCount(4, { timeout: 20_000 });

    // --- a second workspace, then back to the first with its tabs intact ----------------
    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: 'Create workspace…' }).click();
    await createWorkspace(page, 'Workspace 2');
    // A brand-new workspace has no projects and no tabs of its own.
    await expect(page.getByTestId('editor-empty')).toBeVisible();
    await expect(editorTabs(page)).toHaveCount(1);

    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-switcher-item').filter({ hasText: 'Workspace 1' }).click();
    await expect(page.getByTestId('workspace-switcher')).toHaveText(/Workspace 1/, { timeout: 20_000 });
    await expect(editorTabs(page)).toHaveCount(4, { timeout: 20_000 });
    await expect(page.getByTestId('explorer-project-row')).toHaveCount(2, { timeout: 20_000 });
  });

  test('a project leaves one workspace for another, and the empty workspace is deleted', async () => {
    const server = await startTestSoapServer({ fixture: 'calculator' });
    servers.push(server);
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    const trashDir = tempDir('wirebench-e2e-trash-');
    const exportDir = tempDir('wirebench-e2e-export-');

    // The folder pickers cannot be driven, so their answers are queued in order: export, then
    // the two link attempts — all three at the same exported folder.
    launched = await launchApp({
      userDataDir,
      keepUserDataDir: true,
      trashDir,
      folderDialogPaths: [exportDir, exportDir, exportDir],
    });
    const page = launched.window;

    await createWorkspace(page);
    await createProject(page, 'Calculator Project');
    await importCalculator(page, server);
    await createProject(page, 'Scratch');
    await expect(page.getByTestId('explorer-project-row')).toHaveCount(2);

    // --- remove the scratch project, folder and all ------------------------------------
    const scratchRow = page.getByTestId('explorer-project-row').filter({ hasText: 'Scratch' });
    await scratchRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove from workspace' }).click();
    await expect(page.getByTestId('remove-project-dialog')).toBeVisible();
    // Moving the folder to the trash is the default for an internal project; assert it rather
    // than tick it, so a change of default is caught here.
    await expect(page.getByTestId('remove-project-delete-files')).toBeChecked();
    await page.getByTestId('remove-project-confirm').click();
    await expect(page.getByTestId('explorer-project-row')).toHaveCount(1);
    // Nothing is ever deleted: the folder is in the e2e trash, named after the project slug.
    await expect
      .poll(() => (existsSync(trashDir) ? readdirSync(trashDir) : []), { timeout: 20_000 })
      .toEqual([expect.stringMatching(/^Scratch-\d+$/)]);

    // --- export the remaining project --------------------------------------------------
    const calculatorRow = page.getByTestId('explorer-project-row').filter({ hasText: 'Calculator Project' });
    await calculatorRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Export project…' }).click();
    // The toast names the folder main resolved, which on macOS is the `/private` realpath of
    // the temp directory this spec created — so match its last segment, not the whole path.
    await expect(page.getByText(new RegExp(`^Exported to .*${basename(exportDir)}$`))).toBeVisible({
      timeout: 20_000,
    });
    expect(readdirSync(exportDir)).toContain('wirebench.yaml');

    // --- a second workspace, with that folder linked into it ----------------------------
    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: 'Create workspace…' }).click();
    await createWorkspace(page, 'Workspace 2');

    await runCommand(page, 'Link Project Folder');
    const linked = page.getByTestId('explorer-project-row').filter({ hasText: 'Calculator Project' });
    await expect(linked).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('explorer-project-linked-badge')).toBeVisible();
    await openFirstRequest(page);

    // --- linking the same folder again is refused, in words --------------------------
    await runCommand(page, 'Link Project Folder');
    await expect(page.getByText('"Calculator Project" is already in this workspace.')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('explorer-project-row')).toHaveCount(1);

    // --- delete the first workspace from the manage dialog ------------------------------
    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: 'Manage workspaces…' }).click();
    const dialog = page.getByTestId('workspace-manage-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('workspace-rename-name')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Delete Workspace 1' }).click();
    await page.getByTestId('workspace-delete-confirm').click();
    await expect(dialog.getByTestId('workspace-rename-name')).toHaveCount(1, { timeout: 20_000 });
    // Workspace 2 is still the open one, with the linked project still in it.
    await expect(page.getByTestId('workspace-switcher')).toHaveText(/Workspace 2/);
    // The linked folder is never touched by deleting a workspace, whichever workspace it was.
    expect(readdirSync(exportDir)).toContain('wirebench.yaml');
  });
});

/** Runs a command by name from the command palette — the only route some commands have. */
async function runCommand(page: Page, name: string): Promise<void> {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+P`);
  await expect(page.getByTestId('command-palette-input')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette-input')).toBeHidden({ timeout: 20_000 });
}
