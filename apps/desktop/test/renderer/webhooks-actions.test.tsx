import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WebhooksDialogs } from '../../src/renderer/features/webhooks/webhooks-dialogs.js';
import { useWebhooksDialogs } from '../../src/renderer/features/webhooks/webhooks-dialogs-state.js';
import { catchUrlTabId, webhooksActions } from '../../src/renderer/features/webhooks/webhooks-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { readSeen, writeSeen } from '../../src/renderer/state/webhooks-seen.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const SERVER = { url: 'https://wb.test', workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA' };
const HOOK_ID = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const HOOK = {
  id: HOOK_ID,
  workspaceId: SERVER.workspaceId,
  name: 'Payments',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};
const ok = <T,>(value: T) => ({ ok: true as const, value });

function setUp() {
  const api = installWirebenchApi({
    hooks: {
      list: vi.fn().mockResolvedValue(ok({ hooks: [HOOK] })),
      rotate: vi.fn().mockResolvedValue(ok({ hook: HOOK })),
      clear: vi.fn().mockResolvedValue(ok({ done: true })),
      remove: vi.fn().mockResolvedValue(ok({ done: true })),
    },
  });
  useWebhooksStore.setState({
    server: SERVER,
    meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
    hooks: [HOOK],
    loaded: true,
    unseen: { [HOOK_ID]: { count: 5, more: false } },
  });
  return api;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  useWebhooksDialogs.setState({ settings: undefined, confirm: undefined });
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false, unseen: {} });
  useEditorsStore.getState().reset();
});

describe('webhooksActions (webhook-capture §4.2)', () => {
  it('asks before rotating, says the old URL stops working, then rotates and re-lists', async () => {
    const api = setUp();
    render(<WebhooksDialogs />);
    webhooksActions.confirm('rotate', HOOK_ID);
    expect((await screen.findByRole('alertdialog')).textContent).toContain('stops working at once');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(api.hooks.rotate).toHaveBeenCalledWith({ ...SERVER, hookId: HOOK_ID }));
    await waitFor(() => expect(api.hooks.list).toHaveBeenCalled());
  });

  it('clears and marks the catch URL seen with none', async () => {
    const api = setUp();
    await webhooksActions.run('clear', HOOK_ID);
    expect(api.hooks.clear).toHaveBeenCalledWith({ ...SERVER, hookId: HOOK_ID });
    expect(readSeen(SERVER.url, HOOK_ID)).toBe('');
    expect(useWebhooksStore.getState().unseen[HOOK_ID]).toEqual({ count: 0, more: false });
  });

  it('deletes, closes the tab and forgets the seen marker', async () => {
    const api = setUp();
    writeSeen(SERVER.url, HOOK_ID, '01J8ZE00000000000000000001');
    useEditorsStore
      .getState()
      .open({ id: catchUrlTabId(HOOK_ID), kind: 'catch-url', title: 'Payments', hookId: HOOK_ID });
    await webhooksActions.run('delete', HOOK_ID);
    expect(api.hooks.remove).toHaveBeenCalledWith({ ...SERVER, hookId: HOOK_ID });
    expect(useEditorsStore.getState().tabs).toEqual([]);
    expect(readSeen(SERVER.url, HOOK_ID)).toBeUndefined();
  });

  it('copies the full URL', async () => {
    setUp();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await webhooksActions.copyUrl(HOOK_ID);
    expect(writeText).toHaveBeenCalledWith(HOOK.url);
  });

  it('opens the settings dialog for a new catch URL or an existing one', () => {
    webhooksActions.newCatchUrl();
    expect(useWebhooksDialogs.getState().settings).toEqual({ hookId: undefined });
    webhooksActions.openSettings(HOOK_ID);
    expect(useWebhooksDialogs.getState().settings).toEqual({ hookId: HOOK_ID });
  });
});
