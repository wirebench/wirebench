/**
 * The desktop app as this machine's agent in the browser suite (hosted edition spec §13.2 criterion 2,
 * §18.2): the built app from `apps/desktop/out`, launched through Playwright's `_electron` with a
 * throwaway profile, so its *Pair this machine…* and its agent (`main/machine-agent.ts`) are the shipped
 * code, not the CLI's. Its agent listens beside the headless `wirebench agent` global setup starts, on the
 * next free port of the agent's range.
 *
 * Electron needs a display: CI runs the suite under `xvfb-run` (`.github/workflows/ci.yml`, `browser-e2e`).
 * On Linux the agent's key is sealed by the Secret Service, so CI also unlocks a keyring in a D-Bus session;
 * without one the app says it cannot pair, as it would for a person.
 */
import { existsSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { MAIN_PATH } from '../global-setup.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';

/** Set in CI, where a missing desktop build fails the spec instead of skipping it. */
export const DESKTOP_REQUIRED = process.env['WIREBENCH_E2E_REQUIRE_DESKTOP'] === '1';

/** Whether `pnpm build` has made the desktop app's main bundle. */
export function desktopBuilt(): boolean {
  return existsSync(MAIN_PATH);
}

/**
 * Launches the desktop app with a fresh profile, opens a local workspace (the rail's Settings belongs to an
 * open one), and echoes its main process's output with a prefix, so CI's log shows what its agent said.
 */
export async function launchDesktop(): Promise<LaunchedApp> {
  if (!desktopBuilt()) {
    throw new Error(`The desktop app is not built (${MAIN_PATH} is missing): run pnpm build first`);
  }
  const launched = await launchApp(
    // Linux picks the Secret Service only on a desktop it knows; xvfb is none, so without this the keyring
    // CI unlocks goes unused and the agent refuses to pair for want of a place to keep its key.
    process.platform === 'linux'
      ? { extraEnv: { XDG_CURRENT_DESKTOP: process.env['XDG_CURRENT_DESKTOP'] ?? 'GNOME' } }
      : {},
  );
  const child = launched.app.process();
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      process.stdout.write(chunk.replace(/^(?=.)/gm, '[desktop] '));
    });
  }
  await createWorkspace(launched.window, 'Desktop agent');
  return launched;
}

/** Settings → *Paired browsers*: the desktop's own control of its agent. */
export async function openPairedBrowsers(window: Page): Promise<void> {
  if ((await window.getByTestId('settings-page').count()) === 0) {
    await window.getByTestId('activity-settings').click();
  }
  await window.getByTestId('settings-nav-paired-browsers').click();
  await expect(window.getByTestId('paired-browsers-section')).toBeVisible({ timeout: 20_000 });
}

/**
 * *Pair this machine…* with the server's address and the code its tab shows, as the person types them, and
 * waits for the dialog to close on success. Throws with the dialog's own error when the pairing is refused.
 */
export async function pairDesktop(window: Page, serverUrl: string, code: string): Promise<void> {
  await openPairedBrowsers(window);
  await window.getByTestId('machine-agent-pair').click();
  const dialog = window.getByTestId('pair-machine-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('pair-machine-url').fill(serverUrl);
  await dialog.getByTestId('pair-machine-code').fill(code);
  await dialog.getByTestId('pair-machine-submit').click();
  const error = dialog.getByTestId('pair-machine-error');
  await expect
    .poll(
      async () => {
        if (await error.isVisible()) throw new Error(`the desktop refused to pair: ${await error.innerText()}`);
        return await dialog.isVisible();
      },
      { timeout: 60_000 },
    )
    .toBe(false);
}

interface MachineAgentApi {
  status(request: undefined): Promise<{ ok: boolean; value?: { pairings: { pairingId: string }[] } }>;
  unpair(request: { pairingId: string }): Promise<unknown>;
}

/**
 * Unpairs every pairing the desktop holds, at the server and here, through its own `machineAgent.unpair`.
 * Best effort: it runs at the end of a run whose own result matters more.
 */
export async function unpairDesktop(window: Page): Promise<void> {
  try {
    await window.evaluate(async () => {
      const api = (window as unknown as { wirebench: { machineAgent: MachineAgentApi } }).wirebench.machineAgent;
      const status = await api.status(undefined);
      for (const pairing of status.value?.pairings ?? []) await api.unpair({ pairingId: pairing.pairingId });
    });
  } catch (error) {
    console.error('unpairing the desktop app failed:', error);
  }
}
