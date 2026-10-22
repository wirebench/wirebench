import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * The slice of `window.wirebench` the IPC check below calls. Declared locally because
 * `e2e/tsconfig.json` has no DOM lib (see `editor.spec.ts`).
 */
interface AreasWirebenchApi {
  readonly app: {
    areas(
      request: undefined,
    ): Promise<{ readonly ok: boolean; readonly value?: { readonly enabled: readonly string[] } }>;
  };
  readonly ssh: {
    connect(request: unknown): Promise<unknown>;
  };
}

async function searchPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+P`);
  const input = page.getByTestId('command-palette-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(query);
}

// Operator area switches spec (#360): a managed `policy.yaml` with `areas: { ssh: false }` switches the
// SSH area off on this machine and wins over the environment, which says `ssh=on` here.
test.describe('an area locked off by the managed policy', () => {
  let launched: LaunchedApp | undefined;
  let policyDir: string | undefined;

  test.afterEach(async () => {
    await launched?.close().catch(() => undefined);
    launched = undefined;
    if (policyDir !== undefined) {
      removeDirSync(policyDir);
      policyDir = undefined;
    }
  });

  test('removes the rail item, the commands and the IPC channels, and Settings says who set it', async () => {
    policyDir = mkdtempSync(join(tmpdir(), 'wirebench-area-policy-'));
    const policyFile = join(policyDir, 'policy.yaml');
    writeFileSync(policyFile, 'version: 1\nareas:\n  ssh: false\n  graphql: false\n', 'utf8');

    launched = await launchApp({ extraEnv: { WIREBENCH_POLICY_FILE: policyFile, WIREBENCH_AREAS: 'ssh=on' } });
    const page = launched.window;
    await createWorkspace(page, 'Managed');

    // The rail: no Hosts item.
    await expect(page.getByTestId('activity-bar')).toBeVisible();
    await expect(page.getByTestId('activity-hosts')).toHaveCount(0);

    // The palette: none of the area's commands.
    await searchPalette(page, 'Connect to Host');
    await expect(page.getByText('No matching command.')).toBeVisible();
    for (const command of ['Show Hosts', 'New Local Terminal', 'Show Port Forwarding']) {
      await page.getByTestId('command-palette-input').fill(command);
      await expect(page.getByText('No matching command.')).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('status-bar-forwards')).toHaveCount(0);

    // The IPC surface: `app.areas` answers without `ssh`, and main registered no handler for `ssh.connect`.
    const ipc = await page.evaluate(async () => {
      const api = (globalThis as unknown as { wirebench: AreasWirebenchApi }).wirebench;
      const areas = await api.app.areas(undefined);
      let connect: string;
      try {
        await api.ssh.connect({ attemptId: 'x', hostId: 'x' });
        connect = 'answered';
      } catch (error) {
        connect = (error as Error).message;
      }
      return { enabled: areas.value?.enabled ?? [], connect };
    });
    expect(ipc.enabled).not.toContain('ssh');
    expect(ipc.enabled).toContain('explorer');
    expect(ipc.connect).toMatch(/No handler registered for 'ssh\.connect'/);

    // Settings → Features → Areas: the SSH row off, Managed, with the reason; the sub-switches follow it.
    await page.keyboard.press(`${MOD}+Comma`);
    const editor = page.getByTestId('preferences-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await editor.getByRole('button', { name: 'Features', exact: true }).click();
    const ssh = page.getByTestId('area-switch-ssh');
    await expect(ssh).toHaveAttribute('aria-checked', 'false');
    await expect(ssh).toBeDisabled();
    await expect(page.getByTestId('area-note-ssh')).toHaveText('Set by your organisation');
    await expect(page.getByTestId('area-note-telnet')).toHaveText('Requires SSH');
    await expect(page.getByTestId('area-switch-explorer')).toHaveAttribute('aria-checked', 'true');
    // The note at the top names the file, and the unknown id as ignored.
    const policy = page.getByTestId('preferences-policy');
    await expect(policy).toContainText(policyFile);
    await expect(policy).toContainText('areas.graphql');
  });
});
