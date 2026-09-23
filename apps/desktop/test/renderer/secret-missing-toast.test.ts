/**
 * A send refused because a `${secret:name}` token has no value on this machine offers to set it,
 * from a toast, whichever protocol sent. An auth password's `secret-missing` names no token — its
 * fix is the authentication settings — so it gets no such offer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastAction } from '../../src/renderer/components/toast.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { grpcRequestWire, restRequestWire, wsRequestWire } from '../helpers/wire-defaults.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));

const TOKEN_MISSING = {
  code: 'secret-missing',
  message: 'The secret "billing_key" is not on this machine.',
  details: { ref: 'secret:billing_key', name: 'billing_key' },
};
const AUTH_MISSING = {
  code: 'secret-missing',
  message: 'The password for "alice" is not on this machine — enter it in the authentication settings.',
  details: { ref: 'ref-1' },
};

type Protocol = 'soap' | 'rest' | 'grpc' | 'ws';

/** Sends `requestId` over `protocol` with main refusing it as `error`. */
async function failSend(protocol: Protocol, error: typeof TOKEN_MISSING | typeof AUTH_MISSING): Promise<void> {
  const refused = vi.fn().mockResolvedValue({ ok: false, error });
  installWirebenchApi({
    request: {
      send: refused,
      sendRest: refused,
      sendGrpc: refused,
      openWs: refused,
      preflight: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }),
    },
  });
  const store = useExchangesStore.getState();
  if (protocol === 'soap') await store.send('req-1', true);
  if (protocol === 'rest') await store.sendRest('rest-1');
  if (protocol === 'grpc') await store.sendGrpc('grpc-1');
  if (protocol === 'ws') await store.connectWs('ws-1');
  expect(refused).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  showToast.mockReset();
  useExchangesStore.setState({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, wsByRequest: {}, log: [] });
  useDraftsStore.getState().reset();
  useProblemsStore.setState({ items: [] });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
  useUiStore.setState({ secretTokenDialog: null });
  useProjectStore.setState({
    projects: {
      p1: { id: 'p1', name: 'Billing' } as ProjectWire,
      p2: { id: 'p2', name: 'Orders' } as ProjectWire,
    },
    order: [
      { projectId: 'p1', interfaceIds: [] },
      { projectId: 'p2', interfaceIds: [] },
    ],
    requests: { 'req-1': makeDraft({ id: 'req-1', endpointUrl: 'http://127.0.0.1:9/soap' }) },
    restRequests: { 'rest-1': restRequestWire({ id: 'rest-1' }) },
    grpcRequests: { 'grpc-1': grpcRequestWire({ id: 'grpc-1' }) },
    wsRequests: { 'ws-1': wsRequestWire({ id: 'ws-1' }) },
    projectOf: { p1: 'p1', p2: 'p2', 'req-1': 'p2', 'rest-1': 'p2', 'grpc-1': 'p2', 'ws-1': 'p2' },
  });
});

describe('the secret-missing toast', () => {
  it.each<Protocol>(['soap', 'rest', 'grpc', 'ws'])(
    'offers Set value… for a token over %s, opening the dialog on that project and name',
    async (protocol) => {
      await failSend(protocol, TOKEN_MISSING);

      expect(showToast).toHaveBeenCalledTimes(1);
      const [message, action] = showToast.mock.calls[0] as [string, ToastAction];
      expect(message).toBe(TOKEN_MISSING.message);
      expect(action.label).toBe('Set value…');

      action.onClick();
      expect(useUiStore.getState().secretTokenDialog).toEqual({ projectId: 'p2', name: 'billing_key' });
    },
  );

  it.each<Protocol>(['soap', 'rest', 'grpc', 'ws'])('offers nothing for an auth password over %s', async (protocol) => {
    await failSend(protocol, AUTH_MISSING);

    expect(showToast).not.toHaveBeenCalled();
    expect(useUiStore.getState().secretTokenDialog).toBeNull();
  });

  it('offers nothing for any other failure', async () => {
    await failSend('rest', { ...TOKEN_MISSING, code: 'dns' });

    expect(showToast).not.toHaveBeenCalled();
  });

  it('offers Set value… when a message on an open WebSocket session is refused for a token', async () => {
    const refused = vi.fn().mockResolvedValue({ ok: false, error: TOKEN_MISSING });
    installWirebenchApi({ request: { wsSend: refused } });
    useExchangesStore.setState({ wsByRequest: { 'ws-1': { status: 'open', sendId: 'send-1' } } });

    await useExchangesStore
      .getState()
      .sendWsMessage('ws-1', { format: 'text', content: '${secret:billing_key}', expand: true });

    expect(refused).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, action] = showToast.mock.calls[0] as [string, ToastAction];
    expect(message).toBe(TOKEN_MISSING.message);
    action.onClick();
    expect(useUiStore.getState().secretTokenDialog).toEqual({ projectId: 'p2', name: 'billing_key' });
  });

  it('offers nothing when the request belongs to no known project', async () => {
    useProjectStore.setState({ projectOf: { p1: 'p1', p2: 'p2' } });

    await failSend('rest', TOKEN_MISSING);

    expect(showToast).not.toHaveBeenCalled();
  });
});
