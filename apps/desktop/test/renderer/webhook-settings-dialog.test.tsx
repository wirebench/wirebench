/**
 * The Webhooks settings dialog: a collection's target and auth, and a folder's own target
 * override, including the *Catch URLs ▸* picker that fills the target from a live catch URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhookSettingsDialog } from '../../src/renderer/features/webhook-items/webhook-settings-dialog.js';
import { useWebhookItemsDialogs } from '../../src/renderer/features/webhook-items/webhook-items-state.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { restFolderWire } from '../helpers/wire-defaults.js';
import type { CatchUrlWire } from '../../src/shared/wire-types.js';

const SERVER = { url: 'https://srv.test', workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA' };
const HOOK: CatchUrlWire = {
  id: 'h1',
  workspaceId: SERVER.workspaceId,
  name: 'Petstore dev',
  url: 'https://srv.test/hooks/abc/',
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};

const updateWebhooks = vi.fn().mockResolvedValue(undefined);
const setWebhookFolderTarget = vi.fn().mockResolvedValue(undefined);

const targetField = (): HTMLInputElement => screen.getByTestId('webhook-settings-target');

/** Seeds one collection (default target), no folders unless given, and wires the two spied actions. */
function seed(extra: { readonly folders?: Record<string, ReturnType<typeof restFolderWire>> } = {}): void {
  useProjectStore.setState({
    webhooks: { p1: { id: 'webhooks:p1', projectId: 'p1', target: '${webhookTarget}' } },
    folders: extra.folders ?? {},
    projectOf: { p1: 'p1', ...Object.fromEntries(Object.keys(extra.folders ?? {}).map((id) => [id, 'p1'])) },
    updateWebhooks,
    setWebhookFolderTarget,
  });
}

afterEach(() => {
  cleanup();
  updateWebhooks.mockClear();
  setWebhookFolderTarget.mockClear();
  useWebhookItemsDialogs.getState().close();
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false });
});

describe('WebhookSettingsDialog', () => {
  it('shows the collection target and saves a picked catch URL', async () => {
    seed();
    useWebhooksStore.setState({
      server: SERVER,
      meta: { enabled: true, bodyLimitBytes: 1, keep: 1, maxAgeDays: 1 },
      hooks: [HOOK],
    });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    expect(targetField().value).toBe('${webhookTarget}');

    await userEvent.click(screen.getByTestId('webhook-settings-catch-urls'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Petstore dev' }));
    expect(targetField().value).toBe('https://srv.test/hooks/abc/');

    fireEvent.click(screen.getByTestId('webhook-settings-save'));
    expect(updateWebhooks).toHaveBeenCalledWith('p1', { target: 'https://srv.test/hooks/abc/' });
  });

  it('has no Catch URLs menu when the hooks module is off', () => {
    seed();
    useWebhooksStore.setState({ server: SERVER, meta: null, hooks: [] });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    expect(screen.queryByTestId('webhook-settings-catch-urls')).toBeNull();
  });

  it('shows the inherited placeholder for a folder without its own override, and Reset clears it', () => {
    seed({ folders: { f1: restFolderWire({ id: 'f1', apiId: 'webhooks:p1', name: 'Orders' }) } });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1', 'f1'));

    const field = targetField();
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('inherits: ${webhookTarget}');

    fireEvent.click(screen.getByTestId('webhook-settings-reset'));
    expect(setWebhookFolderTarget).toHaveBeenCalledWith('p1', 'f1', null);
  });
});
