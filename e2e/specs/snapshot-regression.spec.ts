/**
 * Snapshot regression, end to end.
 *
 * The engine suite proves the semantic diff and the main suite proves the sidecar store. What only
 * the real app can prove is the chain: a saved request's response becomes a golden file beside it,
 * a later response is compared with that golden in the Snapshot tab, and a change in the body shows
 * up as one difference at its path.
 *
 * Everything is local: the body is a static document on the in-process REST test server, swapped
 * between two sends.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, workspaceProjectDir } from '../helpers/project.js';
import {
  createApi,
  createRestRequest,
  openResponseTab,
  responseStatus,
  saveRequest,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer, type TestRestServerDocument } from '../helpers/test-server.js';

/** Every `*.golden.yaml` under `dir`, recursively. */
function goldenFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.golden.yaml')) {
        found.push(path);
      }
    }
  };
  if (existsSync(dir)) {
    walk(dir);
  }
  return found;
}

test.describe('Snapshot regression', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await server?.close();
    server = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
  });

  test('saves a response as a snapshot and reports the one field that changed', async () => {
    const documents: Record<string, TestRestServerDocument> = {
      '/pets/1': { body: '{"id":1,"name":"Rex","tags":["good"]}', contentType: 'application/json' },
    };
    server = await startTestRestServer({ documents });

    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-snapshot-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;

    await createWorkspace(page, 'Snapshots');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Get pet');
    await setMethodAndUrl(page, 'GET', '/pets/1');
    // A golden lives beside the request's file, so the request has to be on disk first.
    await saveRequest(page);

    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    await openResponseTab(page, 'Snapshot');
    const panel = page.getByTestId('snapshot-panel');
    await expect(panel).toContainText('No snapshot saved.', { timeout: 20_000 });
    await panel.getByRole('button', { name: 'Save as snapshot' }).click();

    // The same response matches the golden it just became, and the golden is a sidecar file.
    const status = page.getByTestId('snapshot-status');
    await expect(status).toHaveText('Matches the snapshot', { timeout: 20_000 });
    const projectDir = workspaceProjectDir(userDataDir);
    await expect.poll(() => goldenFiles(projectDir).length, { timeout: 20_000 }).toBe(1);

    // Key order and whitespace are not differences; the renamed pet is.
    documents['/pets/1'] = { body: '{ "tags": ["good"], "name": "Max", "id": 1 }', contentType: 'application/json' };
    await sendRest(page);
    await expect(status).toHaveText('1 difference', { timeout: 20_000 });
    const differences = page.getByRole('table', { name: 'Snapshot differences' });
    await expect(differences).toContainText('/name');
    await expect(differences).toContainText('Rex');
    await expect(differences).toContainText('Max');

    // Ignoring the path makes the response match again, with the ignored change counted.
    await differences.getByRole('button', { name: 'Ignore /name' }).click();
    await expect(status).toHaveText('Matches the snapshot (1 ignored)', { timeout: 20_000 });
    await expect(page.getByLabel('Ignore rules')).toHaveValue('/name');
  });
});
