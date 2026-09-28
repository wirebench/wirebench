import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { CatchUrlTab } from '../../src/renderer/features/webhooks/catch-url-tab.js';
import { catchUrlTabId } from '../../src/renderer/features/webhooks/webhooks-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { readSeen } from '../../src/renderer/state/webhooks-seen.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import type { CaptureSummaryWire, CaptureViewWire, CatchUrlWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOK_ID = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const HOOK: CatchUrlWire = {
  id: HOOK_ID,
  workspaceId: WS,
  name: 'Payments',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 2,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};
const id = (n: number): string => `01J8ZE${String(n).padStart(20, '0')}`;
const summary = (n: number): CaptureSummaryWire => ({
  id: id(n),
  receivedAt: '2026-09-24T12:00:01.000Z',
  method: n % 2 === 0 ? 'PUT' : 'POST',
  subpath: `/e${n}`,
  bodySize: 7,
  truncated: false,
  sourceIp: '203.0.113.9',
});
const view = (n: number): CaptureViewWire => ({
  ...summary(n),
  query: '',
  headers: [['Content-Type', 'text/plain']],
  bodyBase64: btoa(`body ${n}`),
  contentType: 'text/plain',
  text: `body ${n}`,
  language: 'text',
});
const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = (code: string, message = code) => ({ ok: false as const, error: { code, message } });

function setUp(hooks: Partial<WirebenchApi['hooks']> = {}) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const api = installWirebenchApi({
    hooks: {
      open: vi.fn().mockResolvedValue(ok({ viewId: 'view-1', captures: [summary(2), summary(1)], more: true })),
      older: vi.fn().mockResolvedValue(ok({ captures: [summary(0)], more: false })),
      capture: vi.fn((request: { captureId: string }) =>
        Promise.resolve(ok({ capture: view(Number(request.captureId.slice(-1))) })),
      ),
      ...hooks,
    },
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }),
  });
  useWebhooksStore.setState({
    server: { url: SERVER, workspaceId: WS },
    meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
    hooks: [HOOK],
    loaded: true,
    error: undefined,
  });
  useEditorsStore
    .getState()
    .open({ id: catchUrlTabId(HOOK_ID), kind: 'catch-url', title: 'Payments', hookId: HOOK_ID });
  const utils = render(
    <TooltipPrimitive.Provider>
      <CatchUrlTab hookId={HOOK_ID} />
    </TooltipPrimitive.Provider>,
  );
  return { api, utils, emit: (name: string, payload: unknown) => act(() => listeners.get(name)?.(payload)) };
}

beforeEach(() => {
  localStorage.clear();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});
afterEach(() => {
  cleanup();
  useEditorsStore.getState().reset();
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false, unseen: {} });
});

describe('CatchUrlTab (webhook-capture §4.2, §6)', () => {
  it('shows the URL, lists captures newest first, and opens the newest', async () => {
    const { api } = setUp();
    expect(screen.getByTestId('catch-url-address').textContent).toBe(HOOK.url);
    expect(screen.getByTestId('catch-url-state').textContent).toBe('Enabled');
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('capture-row');
    expect([rows[0]?.textContent, rows[1]?.textContent]).toEqual([
      expect.stringContaining('PUT/e2') as unknown,
      expect.stringContaining('POST/e1') as unknown,
    ]);
    expect(api.hooks.open).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS, hookId: HOOK_ID });
    await waitFor(() => expect(screen.getByTestId('capture-viewer')).toBeTruthy());
    expect(api.hooks.capture).toHaveBeenCalledWith({ viewId: 'view-1', captureId: id(2) });
    expect(readSeen(SERVER, HOOK_ID)).toBe(id(2)); // on screen is seen
  });

  it('streams new captures in on top and loads older ones on request', async () => {
    const { api, emit } = setUp();
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(2));
    emit('hooks.captures', { viewId: 'view-1', mode: 'prepend', captures: [summary(3)] });
    expect(screen.getAllByTestId('capture-row')[0]?.textContent).toContain('/e3');
    emit('hooks.captures', { viewId: 'other-view', mode: 'prepend', captures: [summary(9)] });
    expect(screen.getAllByTestId('capture-row')).toHaveLength(3);

    fireEvent.click(screen.getByTestId('capture-load-older'));
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(4));
    expect(api.hooks.older).toHaveBeenCalledWith({ viewId: 'view-1' });
    expect(screen.queryByTestId('capture-load-older')).toBeNull();
  });

  it('keeps what it has and offers Retry when a later fetch fails', async () => {
    const { emit } = setUp();
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(2));
    emit('hooks.captures', {
      viewId: 'view-1',
      mode: 'error',
      error: { code: 'server-bad-response', message: 'The server answered with an unexpected shape' },
    });
    expect(screen.getByTestId('catch-url-error').textContent).toContain('unexpected shape');
    expect(screen.getAllByTestId('capture-row')).toHaveLength(2);
  });

  it('asks to connect when the server cannot be reached, and retries', async () => {
    const open = vi
      .fn()
      .mockResolvedValueOnce(fail('server-unreachable', 'Could not reach https://wb.test'))
      .mockResolvedValue(ok({ viewId: 'view-2', captures: [], more: false }));
    const { api } = setUp({ open });
    await waitFor(() =>
      expect(screen.getByTestId('catch-url-offline').textContent).toContain(
        'Connect to https://wb.test to see captures',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('capture-empty')).toBeTruthy());
    expect(api.hooks.open).toHaveBeenCalledTimes(2);
  });

  it('says the catch URL was deleted', async () => {
    setUp({ open: vi.fn().mockResolvedValue(fail('hooks-not-found')) });
    await waitFor(() =>
      expect(screen.getByTestId('catch-url-deleted').textContent).toBe('This catch URL was deleted.'),
    );
  });

  it('closes itself when the workspace is no longer reachable', async () => {
    setUp({ open: vi.fn().mockResolvedValue(fail('teams-workspace-not-found')) });
    await waitFor(() => expect(useEditorsStore.getState().tabs).toEqual([]));
  });

  it('closes the view in main when the tab goes away', async () => {
    const { api, utils } = setUp();
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(2));
    utils.unmount();
    expect(api.hooks.close).toHaveBeenCalledWith({ viewId: 'view-1' });
  });
});
