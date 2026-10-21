import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { grpcApiRow, importProto, placeGreeterProtos } from '../helpers/grpc.js';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, saveAll, workspaceProjectDir } from '../helpers/project.js';
import { startTestGrpcServer, type TestGrpcServer } from '../helpers/test-server.js';

// Kind modules spec §7: a project holding a container of a kind this run switched off opens with
// that container as a placeholder row, named, saying why, and offering nothing else.
test.describe('a kind switched off with WIREBENCH_FEATURES', () => {
  let launched: LaunchedApp | undefined;
  let server: TestGrpcServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    await launched?.close().catch(() => undefined);
    launched = undefined;
    await server?.close();
    server = undefined;
    if (userDataDir !== undefined) {
      removeDirSync(userDataDir);
      userDataDir = undefined;
    }
  });

  test('leaves its container in the explorer as a placeholder row', async () => {
    server = await startTestGrpcServer();
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-kinds-off-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    let page = launched.window;
    await createWorkspace(page, 'Kinds');
    await createProject(page, 'Greet');
    await importProto(page, placeGreeterProtos(workspaceProjectDir(userDataDir, 'Greet')), 'Greeter', server.target);
    await expect(grpcApiRow(page, 'Greeter')).toContainText('gRPC');
    await saveAll(page);
    await launched.close();

    // The same profile reopens the same workspace, this time with gRPC off.
    launched = await launchApp({ userDataDir, keepUserDataDir: true, extraEnv: { WIREBENCH_FEATURES: 'grpc=off' } });
    page = launched.window;
    await page.getByRole('button', { name: 'Expand all' }).click();
    const row = page.getByTestId('explorer-placeholder-row').filter({ hasText: 'Greeter' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId('explorer-placeholder-badge')).toHaveText('gRPC');
    await expect(row.getByTestId('explorer-placeholder-badge')).toHaveAttribute('title', 'gRPC is switched off');

    await row.click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveText(['gRPC is switched off']);
    await page.keyboard.press('Escape');

    // Settings → Features (phase 4 spec §4.3) shows the row off with no reason line (it is the
    // preference itself), and turning it on only says it applies after a restart.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
    const editor = page.getByTestId('preferences-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.getByRole('button', { name: 'Features', exact: true }).click();
    const grpc = page.getByTestId('feature-switch-grpc');
    await expect(grpc).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('feature-note-grpc')).toHaveCount(0);
    await expect(page.getByTestId('feature-stage-mcp')).toHaveText('Experimental');
    await grpc.click();
    await expect(grpc).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('feature-note-grpc')).toHaveText('Applies after restart');
    // Still off in this run: the placeholder row stays.
    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('explorer-placeholder-row').filter({ hasText: 'Greeter' })).toBeVisible();
  });
});
