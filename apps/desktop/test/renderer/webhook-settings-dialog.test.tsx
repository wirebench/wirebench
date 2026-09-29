/**
 * The Webhooks settings dialog: a collection's target and auth, and a folder's own target
 * override, including the *Catch URLs ▸* picker that fills the target from a live catch URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebhookSettingsDialog } from '../../src/renderer/features/webhook-items/webhook-settings-dialog.js';
import { useWebhookItemsDialogs } from '../../src/renderer/features/webhook-items/webhook-items-state.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restFolderWire } from '../helpers/wire-defaults.js';
import type { AuthConfigWire, CatchUrlWire, WebhookSigningWire } from '../../src/shared/wire-types.js';

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
const setWebhookFolderSigning = vi.fn().mockResolvedValue(undefined);

const HMAC: WebhookSigningWire = {
  mode: 'sign',
  scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
  secretRef: 'ref-orders',
  secretEnv: 'ORDERS_SIGNING',
};

const targetField = (): HTMLInputElement => screen.getByTestId('webhook-settings-target');

/** Seeds one collection (default target), no folders unless given, and wires the two spied actions. */
function seed(
  extra: {
    readonly folders?: Record<string, ReturnType<typeof restFolderWire>>;
    readonly auth?: AuthConfigWire;
    readonly signing?: WebhookSigningWire;
  } = {},
): void {
  useProjectStore.setState({
    webhooks: {
      p1: {
        id: 'webhooks:p1',
        projectId: 'p1',
        target: '${webhookTarget}',
        ...(extra.auth !== undefined ? { auth: extra.auth } : {}),
        ...(extra.signing !== undefined ? { signing: extra.signing } : {}),
      },
    },
    folders: extra.folders ?? {},
    projectOf: { p1: 'p1', ...Object.fromEntries(Object.keys(extra.folders ?? {}).map((id) => [id, 'p1'])) },
    updateWebhooks,
    setWebhookFolderTarget,
    setWebhookFolderSigning,
  });
}

afterEach(() => {
  cleanup();
  updateWebhooks.mockClear();
  setWebhookFolderTarget.mockClear();
  setWebhookFolderSigning.mockClear();
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
    await waitFor(() => expect(updateWebhooks).toHaveBeenCalledWith('p1', { target: 'https://srv.test/hooks/abc/' }));
  });

  it('sends an auth key only when the Auth block was actually touched', async () => {
    seed();
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    fireEvent.change(screen.getByLabelText('Webhooks authentication type'), { target: { value: 'none' } });
    fireEvent.click(screen.getByTestId('webhook-settings-save'));
    await waitFor(() =>
      expect(updateWebhooks).toHaveBeenCalledWith('p1', { target: '${webhookTarget}', auth: { type: 'none' } }),
    );
  });

  it.each([
    ['Save', () => fireEvent.click(screen.getByTestId('webhook-settings-save'))],
    ['Enter', () => fireEvent.submit(screen.getByTestId('webhook-settings-target').closest('form')!)],
  ])('stores a typed but unsaved secret and saves its reference on %s', async (_label, submit) => {
    installWirebenchApi({ secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-flushed' } }) } });
    seed({ auth: { type: 'bearer' } });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Webhooks token'), 'abc123def456ghi789');
    submit();

    await waitFor(() =>
      expect(updateWebhooks).toHaveBeenCalledWith('p1', {
        target: '${webhookTarget}',
        auth: { type: 'bearer', tokenRef: 'ref-flushed' },
      }),
    );
  });

  it("shows the collection's OAuth2 token status once OAuth2 is saved on it", async () => {
    const status = vi.fn().mockResolvedValue({ ok: true, value: { state: 'none' } });
    installWirebenchApi({ oauth2: { status } });
    seed({ auth: { type: 'oauth2', grant: 'client-credentials' } });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    expect(screen.getByTestId('oauth2-status')).toBeTruthy();
    await waitFor(() => expect(status).toHaveBeenCalledWith({ ownerId: 'webhooks:p1' }));
  });

  it('offers Catch URLs ▸ on a folder too, filling its override', async () => {
    seed({ folders: { f1: restFolderWire({ id: 'f1', apiId: 'webhooks:p1', name: 'Orders' }) } });
    useWebhooksStore.setState({
      server: SERVER,
      meta: { enabled: true, bodyLimitBytes: 1, keep: 1, maxAgeDays: 1 },
      hooks: [HOOK],
    });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1', 'f1'));

    await userEvent.click(screen.getByTestId('webhook-settings-catch-urls'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Petstore dev' }));
    fireEvent.click(screen.getByTestId('webhook-settings-save'));
    await waitFor(() => expect(setWebhookFolderTarget).toHaveBeenCalledWith('p1', 'f1', 'https://srv.test/hooks/abc/'));
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

describe('WebhookSettingsDialog signing (§5.2)', () => {
  const mode = (): HTMLSelectElement => screen.getByTestId('signing-mode');
  const optionValues = (): string[] => [...mode().options].map((option) => option.value);
  const save = (): void => {
    fireEvent.click(screen.getByTestId('webhook-settings-save'));
  };

  it('offers the collection None and the schemes but no Inherit, and shows an unset signing as None', () => {
    seed();
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    expect(optionValues()).toEqual(['none', 'hmac', 'timestamped', 'standard']);
    expect(mode().value).toBe('none');
    expect(screen.queryByTestId('webhook-settings-signing-source')).toBeNull();
  });

  it('saves None on an unset collection once chosen, and leaves signing out when untouched', async () => {
    seed();
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    fireEvent.change(mode(), { target: { value: 'none' } });
    save();
    await waitFor(() =>
      expect(updateWebhooks).toHaveBeenCalledWith('p1', { target: '${webhookTarget}', signing: { mode: 'none' } }),
    );
  });

  it("changes the collection's scheme to None", async () => {
    installWirebenchApi();
    seed({ signing: HMAC });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    expect(mode().value).toBe('hmac');
    fireEvent.change(mode(), { target: { value: 'none' } });
    save();
    await waitFor(() =>
      expect(updateWebhooks).toHaveBeenCalledWith('p1', { target: '${webhookTarget}', signing: { mode: 'none' } }),
    );
  });

  it('stores a typed but unsaved signing secret and saves its reference with the collection', async () => {
    const set = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-flushed' } });
    installWirebenchApi({ secrets: { set } });
    seed();
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    fireEvent.change(mode(), { target: { value: 'standard' } });
    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Signing secret', { selector: 'input' }), 'abc123def456ghi789');
    save();

    await waitFor(() =>
      expect(updateWebhooks).toHaveBeenCalledWith('p1', {
        target: '${webhookTarget}',
        signing: {
          mode: 'sign',
          scheme: { kind: 'standard', toleranceSec: 300 },
          secretEnv: 'WEBHOOKS',
          secretRef: 'ref-flushed',
        },
      }),
    );
  });

  it('blocks Save while the CI name breaks the envName rule', async () => {
    installWirebenchApi();
    seed({ signing: HMAC });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1'));

    fireEvent.change(screen.getByTestId('signing-ci-name'), { target: { value: '9lives' } });
    expect(screen.getByTestId('signing-ci-name-problem')).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>('webhook-settings-save').disabled).toBe(true);
    fireEvent.submit(targetField().closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateWebhooks).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('signing-ci-name'), { target: { value: 'lives_9' } });
    expect(screen.getByTestId<HTMLButtonElement>('webhook-settings-save').disabled).toBe(false);
    save();
    await waitFor(() =>
      expect(updateWebhooks).toHaveBeenCalledWith('p1', {
        target: '${webhookTarget}',
        signing: { ...HMAC, secretEnv: 'LIVES_9' },
      }),
    );
  });

  it('shows what a folder inherits, and sets its own signing to None', async () => {
    seed({
      signing: HMAC,
      folders: { g1: restFolderWire({ id: 'g1', apiId: 'webhooks:p1', name: 'Orders' }) },
    });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1', 'g1'));

    expect(optionValues()).toEqual(['inherit', 'none', 'hmac', 'timestamped', 'standard']);
    expect(mode().value).toBe('inherit');
    expect(screen.getByTestId('webhook-settings-signing-source').textContent).toBe(
      'Inherits HMAC of body · SHA-256 · hex · X-Signature from the Webhooks collection',
    );

    fireEvent.change(mode(), { target: { value: 'none' } });
    save();
    await waitFor(() => expect(setWebhookFolderSigning).toHaveBeenCalledWith('p1', 'g1', { mode: 'none' }));
    expect(setWebhookFolderTarget).toHaveBeenCalledWith('p1', 'g1', null);
  });

  it("puts a folder back to Inherit with null, and leaves an untouched folder's signing alone", async () => {
    installWirebenchApi();
    seed({ folders: { g1: restFolderWire({ id: 'g1', apiId: 'webhooks:p1', name: 'Orders', signing: HMAC }) } });
    render(<WebhookSettingsDialog />);
    act(() => useWebhookItemsDialogs.getState().openSettings('p1', 'g1'));

    expect(mode().value).toBe('hmac');
    save();
    await waitFor(() => expect(setWebhookFolderTarget).toHaveBeenCalled());
    expect(setWebhookFolderSigning).not.toHaveBeenCalled();

    act(() => useWebhookItemsDialogs.getState().openSettings('p1', 'g1'));
    fireEvent.change(mode(), { target: { value: 'inherit' } });
    save();
    await waitFor(() => expect(setWebhookFolderSigning).toHaveBeenCalledWith('p1', 'g1', null));
  });
});
