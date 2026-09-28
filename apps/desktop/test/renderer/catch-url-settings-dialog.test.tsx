import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  CatchUrlSettingsDialog,
  formOf,
  problemOf,
} from '../../src/renderer/features/webhooks/catch-url-settings-dialog.js';
import { useWebhooksDialogs } from '../../src/renderer/features/webhooks/webhooks-dialogs-state.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import type { CatchUrlWire } from '../../src/shared/wire-types.js';

const SERVER = { url: 'https://wb.test', workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA' };
const HOOK: CatchUrlWire = {
  id: '01J8ZC5Q0V7R3T9XK2M4N6H001',
  workspaceId: SERVER.workspaceId,
  name: 'Payments',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 202, contentType: 'application/json', body: '{"ok":true}', delayMs: 250 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};
const ok = <T,>(value: T) => ({ ok: true as const, value });

function setUp(role: 'viewer' | 'editor', hooks: Partial<WirebenchApi['hooks']> = {}) {
  const api = installWirebenchApi({
    hooks: {
      list: vi.fn().mockResolvedValue(ok({ hooks: [HOOK] })),
      create: vi.fn().mockResolvedValue(ok({ hook: HOOK })),
      update: vi.fn().mockResolvedValue(ok({ hook: HOOK })),
      ...hooks,
    },
  });
  useSyncStore.setState({ status: { ...useSyncStore.getState().status, role } });
  useWebhooksStore.setState({
    server: SERVER,
    meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
    hooks: [HOOK],
    loaded: true,
  });
  render(<CatchUrlSettingsDialog />);
  return api;
}

const field = (testId: string): HTMLInputElement => screen.getByTestId(testId);
const type = (testId: string, value: string): void => {
  fireEvent.change(field(testId), { target: { value } });
};

afterEach(() => {
  cleanup();
  useWebhooksDialogs.setState({ settings: undefined, confirm: undefined });
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false });
  useSyncStore.getState().reset();
  useEditorsStore.getState().reset();
});

describe('CatchUrlSettingsDialog (webhook-capture §4.2)', () => {
  it('creates a catch URL as an editor and opens its tab', async () => {
    const api = setUp('editor');
    act(() => useWebhooksDialogs.getState().openSettings(undefined));
    expect(field('catch-url-status').value).toBe('200');
    type('catch-url-name', '  Payments  ');
    type('catch-url-status', '202');
    type('catch-url-body', '{"ok":true}');
    fireEvent.click(screen.getByTestId('catch-url-save'));
    await waitFor(() =>
      expect(api.hooks.create).toHaveBeenCalledWith({
        ...SERVER,
        name: 'Payments',
        enabled: true,
        response: { status: 202, contentType: null, body: '{"ok":true}', delayMs: 0 },
      }),
    );
    await waitFor(() => expect(useWebhooksDialogs.getState().settings).toBeUndefined());
    await waitFor(() => expect(useEditorsStore.getState().tabs.map((tab) => tab.kind)).toEqual(['catch-url']));
  });

  it('edits an existing catch URL, filled from the list', async () => {
    const api = setUp('editor');
    act(() => useWebhooksDialogs.getState().openSettings(HOOK.id));
    expect([
      field('catch-url-name').value,
      field('catch-url-content-type').value,
      field('catch-url-delay').value,
    ]).toEqual(['Payments', 'application/json', '250']);
    fireEvent.click(field('catch-url-enabled'));
    type('catch-url-delay', '0');
    fireEvent.click(screen.getByTestId('catch-url-save'));
    await waitFor(() =>
      expect(api.hooks.update).toHaveBeenCalledWith({
        ...SERVER,
        hookId: HOOK.id,
        name: 'Payments',
        enabled: false,
        response: { status: 202, contentType: 'application/json', body: '{"ok":true}', delayMs: 0 },
      }),
    );
  });

  it("shows the server's refusal and stays open", async () => {
    setUp('editor', {
      create: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'hooks-name-taken', message: 'This workspace already has a catch URL with this name.' },
      }),
    });
    act(() => useWebhooksDialogs.getState().openSettings(undefined));
    type('catch-url-name', 'Payments');
    fireEvent.click(screen.getByTestId('catch-url-save'));
    expect((await screen.findByTestId('catch-url-settings-problem')).textContent).toContain('already has');
    expect(useWebhooksDialogs.getState().settings).toEqual({ hookId: undefined });
  });

  it('refuses what the server would refuse before sending it', () => {
    setUp('editor');
    act(() => useWebhooksDialogs.getState().openSettings(undefined));
    type('catch-url-name', 'Payments');
    type('catch-url-status', '700');
    expect(screen.getByTestId('catch-url-settings-problem').textContent).toBe('Status is a number from 200 to 599.');
    expect(screen.getByTestId<HTMLButtonElement>('catch-url-save').disabled).toBe(true);
  });

  it('is read only for a viewer', () => {
    setUp('viewer');
    act(() => useWebhooksDialogs.getState().openSettings(HOOK.id));
    for (const testId of [
      'catch-url-name',
      'catch-url-enabled',
      'catch-url-status',
      'catch-url-content-type',
      'catch-url-body',
      'catch-url-delay',
    ])
      expect(field(testId).disabled).toBe(true);
    expect(screen.queryByTestId('catch-url-save')).toBeNull();
    expect(screen.getByText(/Only editors can change/)).toBeTruthy();
  });
});

describe('problemOf', () => {
  const valid = formOf(undefined);
  it.each([
    [{ name: '   ' }, 'Give the catch URL a name.'],
    [{ name: 'x'.repeat(101) }, 'Names are at most 100 characters.'],
    [{ status: '20x' }, 'Status is a number from 200 to 599.'],
    [{ delayMs: '30001' }, 'The delay is 0 to 30000 ms.'],
    [{ contentType: 'text/plain\nX-Evil: 1' }, 'The content type is up to 255 printable ASCII characters.'],
    [{ body: 'é'.repeat(40_000) }, 'The body is at most 64 KiB.'],
  ])('refuses %j', (patch, message) => {
    expect(problemOf({ ...valid, name: 'Payments', ...patch })).toBe(message);
  });
  it('accepts the defaults with a name', () => {
    expect(problemOf({ ...valid, name: 'Payments' })).toBeUndefined();
  });
});
