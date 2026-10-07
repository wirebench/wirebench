/**
 * Every shown REST response follows the show-secrets flag, not only the HTTP Log's selected row.
 *
 * Main redacts each copy as it is read (`exchanges.get`), so a pane's copy is as current as the flag
 * was when it was fetched. These tests wire the renderer's `exchanges.get` to the real handler over a
 * real `ExchangeCache`, flip the flag the way the toolbar does, and read what a pane for a send that
 * is not selected anywhere — and an environment-compare tab — show afterwards, both ways.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ExchangeCache } from '../../src/main/exchange-cache.js';
import { registerExchangeChannels } from '../../src/main/ipc/exchanges.js';
import { ShowSecretsFlag } from '../../src/main/secrets.js';
import { RestResponsePane } from '../../src/renderer/features/rest-editor/response/response-pane.js';
import { subscribeToSecretsVisibility, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useSecretsVisibilityStore } from '../../src/renderer/state/secrets-visibility.js';
import type { RestExchangeSummary } from '../../src/shared/wire-types.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeRestExchange } from '../mocks/exchange-fixtures.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: () => undefined },
  shell: { openPath: () => Promise.resolve('') },
  app: { getPath: () => '/tmp' },
}));

const SECRET = 'echoed-pane-secret-284';

/** A REST exchange whose body echoes the secret; `show` decides whether it is masked, as main's view does. */
function restView(sendId: string): (show: boolean) => RestExchangeSummary {
  return (show) => makeRestExchange({ sendId, text: `{"echo":"${show ? SECRET : '<redacted>'}"}` });
}

/** The renderer's `exchanges.get`, answered by main's real handler. */
function realExchangesGet(request: { sendId: string }): ReturnType<WirebenchApi['exchanges']['get']> {
  const handler = handlers.get('exchanges.get');
  if (handler === undefined) {
    throw new Error('exchanges.get was never registered');
  }
  return handler({ sender: {} }, request) as ReturnType<WirebenchApi['exchanges']['get']>;
}

let flag: ShowSecretsFlag;
let unsubscribe: () => void;

beforeEach(() => {
  handlers.clear();
  const cache = new ExchangeCache();
  for (const sendId of ['send-a', 'send-b', 'batch-1:dev', 'batch-1:prod']) {
    const view = restView(sendId);
    cache.putRest(sendId, view(true), new Uint8Array(), view);
  }
  flag = new ShowSecretsFlag();
  registerExchangeChannels(cache, flag);
  installWirebenchApi({
    exchanges: { get: vi.fn(realExchangesGet) },
    secrets: {
      setShowSecrets: vi.fn((request: { show: boolean }) => {
        flag.set(request.show);
        return Promise.resolve({ ok: true as const, value: { show: flag.get() } });
      }),
      getShowSecrets: vi.fn(() => Promise.resolve({ ok: true as const, value: { show: flag.get() } })),
    },
  });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
  useSecretsVisibilityStore.setState({ show: false });
  useEditorsStore.setState({ tabs: [], activeId: undefined });
  useExchangesStore.setState({
    log: [],
    restByRequest: {
      'rq-a': { status: 'done', sendId: 'send-a', exchange: restView('send-a')(false) },
      'rq-b': { status: 'done', sendId: 'send-b', exchange: restView('send-b')(false) },
    },
  });
  unsubscribe = subscribeToSecretsVisibility();
});

afterEach(() => {
  unsubscribe();
  cleanup();
});

/** The pane for `rq-b`, reading its state from the store as the editor does. */
function PaneB() {
  const state = useExchangesStore((store) => store.restByRequest['rq-b']);
  return <RestResponsePane requestId="rq-b" state={state} />;
}

function paneText(container: HTMLElement): string {
  const fields = [...container.querySelectorAll('textarea')].map((field) => field.value);
  return [container.textContent, ...fields].join('\n');
}

describe('the show-secrets flag', () => {
  it('re-reads a pane that is not selected in the HTTP Log, both ways', async () => {
    const { container } = render(
      <TooltipPrimitive.Provider>
        <PaneB />
      </TooltipPrimitive.Provider>,
    );
    expect(paneText(container)).not.toContain(SECRET);

    await act(() => useSecretsVisibilityStore.getState().toggle());
    await waitFor(() => {
      expect(paneText(container)).toContain(SECRET);
    });

    await act(() => useSecretsVisibilityStore.getState().toggle());
    await waitFor(() => {
      expect(paneText(container)).not.toContain(SECRET);
    });
    expect(paneText(container)).toContain('<redacted>');
  });

  it('re-reads every cached REST exchange through exchanges.get, however the flag flipped', async () => {
    await act(() => useSecretsVisibilityStore.getState().setShow(true));
    await waitFor(() => {
      const panes = useExchangesStore.getState().restByRequest;
      expect(panes['rq-a']?.exchange?.text).toContain(SECRET);
      expect(panes['rq-b']?.exchange?.text).toContain(SECRET);
    });

    // A flag changed behind the store's back arrives through `refresh`, and counts too.
    flag.set(false);
    await act(() => useSecretsVisibilityStore.getState().refresh());
    await waitFor(() => {
      const panes = useExchangesStore.getState().restByRequest;
      expect(panes['rq-a']?.exchange?.text).not.toContain(SECRET);
      expect(panes['rq-b']?.exchange?.text).not.toContain(SECRET);
    });
  });

  it('re-reads the results of an environment-compare tab, both ways', async () => {
    const result = (envId: string) =>
      ({
        outcome: 'ok',
        environmentId: envId,
        environmentName: envId,
        kind: 'rest',
        rest: restView(`batch-1:${envId}`)(false),
      }) as const;
    useEditorsStore.setState({
      tabs: [
        {
          id: 'compare:rq-a',
          kind: 'env-compare',
          title: 'Compare',
          envCompare: {
            baselineId: 'dev',
            results: [
              result('dev'),
              result('prod'),
              { outcome: 'error', environmentId: 'qa', environmentName: 'qa', code: 'dns', message: 'not found' },
            ],
          },
        },
      ],
    });
    const texts = (): (string | undefined)[] =>
      (useEditorsStore.getState().tabs[0]?.envCompare?.results ?? []).map((entry) =>
        entry.outcome === 'ok' ? entry.rest?.text : entry.message,
      );

    await act(() => useSecretsVisibilityStore.getState().toggle());
    await waitFor(() => {
      expect(texts()).toEqual([`{"echo":"${SECRET}"}`, `{"echo":"${SECRET}"}`, 'not found']);
    });

    await act(() => useSecretsVisibilityStore.getState().toggle());
    await waitFor(() => {
      expect(texts()).toEqual(['{"echo":"<redacted>"}', '{"echo":"<redacted>"}', 'not found']);
    });
  });
});
