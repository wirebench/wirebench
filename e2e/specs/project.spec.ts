import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** Absolute path of the single `.request.yaml` under an operation folder, whatever it is named. */
function requestYamlIn(operationDir: string): string {
  const name = readdirSync(operationDir).find((entry) => entry.endsWith('.request.yaml'));
  if (name === undefined) {
    throw new Error(`no .request.yaml under ${operationDir}`);
  }
  return join(operationDir, name);
}

test.describe('projects on disk', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir: string | undefined;
  let projectDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    for (const dir of [userDataDir, projectDir]) {
      if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = undefined;
    projectDir = undefined;
  });

  test('new project, import, relaunch, and the request comes back from disk', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Calculator Project');

    // --- first launch: create a project and import into it -------------------
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    await expect(launched.window.getByTestId('welcome-screen')).toBeVisible();
    await expect(launched.window.getByText('No projects yet.')).toBeVisible();

    await launched.window.getByTestId('welcome-new-project').click();
    const nameField = launched.window.getByTestId('new-project-name');
    await expect(nameField).toBeVisible();
    await expect(nameField).toHaveValue('Calculator Project');
    await launched.window.getByTestId('new-project-create').click();

    await expect(launched.window.getByTestId('title-bar')).toContainText('Calculator Project');

    await launched.window.getByTestId('welcome-import').click();
    await launched.window.getByTestId('import-url-input').fill(server.wsdlUrl);
    await launched.window.getByTestId('import-submit').click();

    const addRow = launched.window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Add' }).first();
    await expect(addRow).toBeVisible({ timeout: 20_000 });
    // The import writes one `Request 1` per operation, straight to disk.
    await expect(
      launched.window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first(),
    ).toBeVisible({ timeout: 20_000 });

    await launched.close();
    launched = undefined;

    // --- second launch: the project is in Recent, and reopens from disk ------
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const recent = launched.window.getByTestId('recent-project').first();
    await expect(recent).toBeVisible();
    await expect(recent).toContainText('Calculator Project');

    await recent.click();

    const restored = launched.window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first();
    await expect(restored).toBeVisible({ timeout: 20_000 });
    // The context menu is the stable way to open a request (react-arborist owns double-click).
    await restored.click({ button: 'right' });
    await launched.window.getByRole('menuitem', { name: 'Open', exact: true }).click();

    await expect(launched.window.getByTestId('request-editor')).toBeVisible({ timeout: 20_000 });
    // The envelope is the one saved on disk, not one regenerated from the network.
    await expect(launched.window.getByTestId('request-editor')).toContainText('intA', { timeout: 20_000 });
  });

  test('an external edit raises the reload banner, and reloading picks it up', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Watched');

    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    await launched.window.getByTestId('welcome-new-project').click();
    await launched.window.getByTestId('new-project-create').click();
    await expect(launched.window.getByTestId('title-bar')).toContainText('Watched');

    await launched.window.getByTestId('welcome-import').click();
    await launched.window.getByTestId('import-url-input').fill(server.wsdlUrl);
    await launched.window.getByTestId('import-submit').click();
    await expect(
      launched.window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Request 1' }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Writes the app just made are suppressed for `SELF_WRITE_TTL_MS` (2s) so an autosave
    // never prompts the user to reload their own work; wait that out before editing by hand.
    await launched.window.waitForTimeout(2_500);

    // Rename the request by editing its YAML the way a text editor or a `git pull` would.
    const interfaceSlug = readdirSync(join(projectDir, 'interfaces'))[0]!;
    const operationsDir = join(projectDir, 'interfaces', interfaceSlug, 'operations');
    const operationDir = join(operationsDir, readdirSync(operationsDir)[0]!);
    const yamlPath = requestYamlIn(operationDir);
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('name: Request 1', 'name: Edited externally'));

    const banner = launched.window.getByTestId('changed-on-disk-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });

    await launched.window.getByTestId('changed-on-disk-reload').click();

    await expect(
      launched.window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Edited externally' }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(banner).toBeHidden();
  });
});
