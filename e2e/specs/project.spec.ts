import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProjectWithCalculator,
  expectReopenedWorkspace,
  openFirstRequest,
  workspaceProjectDir,
} from '../helpers/project.js';
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

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    userDataDir = undefined;
  });

  test('relaunch reopens the last workspace and its project, and the request comes back from disk', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    // --- first launch: a fresh profile shows the picker; create a workspace, a project, import
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await expect(launched.window.getByTestId('workspace-picker')).toBeVisible();
    await expect(launched.window.getByText('No workspaces yet.')).toBeVisible();

    // The import writes one `Request 1` per operation, straight to disk.
    await createProjectWithCalculator(launched.window, server, { expectProjectName: 'Calculator Project' });
    await expect(launched.window.getByTestId('title-bar')).toContainText('Workspace 1');
    await expect(
      launched.window.locator('[data-testid="explorer-tree-row"]', { hasText: 'Add' }).first(),
    ).toBeVisible();

    await launched.close();
    launched = undefined;

    // --- second launch: the workspace reopens by itself, never showing the picker -----------
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await expectReopenedWorkspace(launched.window);

    await openFirstRequest(launched.window);
    // The envelope is the one saved on disk, not one regenerated from the network.
    await expect(launched.window.getByTestId('request-editor')).toContainText('intA', { timeout: 20_000 });
  });

  test('an external edit raises the reload banner, and reloading picks it up', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    await createProjectWithCalculator(launched.window, server, { expectProjectName: 'Watched' });
    // The project lives inside the workspace: `<userData>/workspaces/<id>/projects/<slug>`.
    const projectDir = workspaceProjectDir(userDataDir);

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
