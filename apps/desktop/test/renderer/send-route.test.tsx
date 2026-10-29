/**
 * Routing a browser tab's send (hosted edition spec §18.4): `request.route` first, then the server or the
 * paired agent (`request.bundle` → `agent.send` → `exchanges.recordAgentSend`); the chip and its pins; the
 * agent-cookies need only the tab can see; Settings → This machine. And the desktop, which has no
 * `env.agent`, asks nothing and shows nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEnv, AgentPairingView, AgentStatus } from '../../src/preload/build-api.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore, type RequestDraft } from '../../src/renderer/state/project.js';
import { useSendRouteStore, watchAgent } from '../../src/renderer/state/send-route.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { showToast } from '../../src/renderer/components/toast.js';
import { RouteChip } from '../../src/renderer/features/request-editor/route-chip.js';
import { ThisMachineSection } from '../../src/renderer/features/preferences/sections/this-machine-section.js';
import { availableNav } from '../../src/renderer/features/preferences/settings-model.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeRestExchange } from '../mocks/exchange-fixtures.js';
import { REQUEST_PROPERTIES, restApiWire, restRequestWire } from '../helpers/wire-defaults.js';

vi.mock('../../src/renderer/components/toast.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/components/toast.js')>()),
  showToast: vi.fn(),
}));

const BUNDLE = { version: 1, kind: 'rest', workspaceId: 'ws-1', itemId: 'rest-1', files: [], secretNames: [] };
const INFO = { pins: { request: false, workspace: false }, workspaceId: 'ws-1', targetHost: 'api.example.test' };

/** A fake `env.agent` the test drives: its status, and the pairing calls Settings makes. */
function fakeAgent(initial: AgentStatus = 'connected') {
  let status = initial;
  const listeners = new Set<(next: AgentStatus) => void>();
  let pairings: AgentPairingView[] = [
    {
      id: 'pair-1',
      port: 47615,
      sshOptIn: false,
      createdAt: '2026-10-29T10:00:00Z',
      lastSeenAt: '2026-10-29T11:00:00Z',
    },
  ];
  const env = {
    serverOrigin: 'https://acme.example.test',
    status: () => status,
    version: () => (status === 'connected' ? '7.0.0' : undefined),
    onStatus: (listener: (next: AgentStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pairings: vi.fn(() => Promise.resolve(pairings)),
    createPairingCode: vi.fn(() => Promise.resolve({ code: 'K7QW2P', expiresAt: '2026-10-29T12:10:00Z' })),
    unpair: vi.fn((id: string) => {
      pairings = pairings.filter((one) => one.id !== id);
      return Promise.resolve();
    }),
    refresh: vi.fn(() => Promise.resolve()),
  } satisfies AgentEnv;
  return {
    env,
    set(next: AgentStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

interface Calls {
  readonly route: ReturnType<typeof vi.fn>;
  readonly bundle: ReturnType<typeof vi.fn>;
  readonly setRoutePin: ReturnType<typeof vi.fn>;
  readonly sendRest: ReturnType<typeof vi.fn>;
  readonly send: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly record: ReturnType<typeof vi.fn>;
  readonly agentSend: ReturnType<typeof vi.fn>;
  readonly agentCancel: ReturnType<typeof vi.fn>;
  readonly domains: ReturnType<typeof vi.fn>;
}

function install(agent: AgentEnv | undefined, capabilities: readonly string[] = ['send:public']): Calls {
  const calls: Calls = {
    route: vi.fn().mockResolvedValue({ ok: true, value: { route: 'agent', needs: ['loopback-target'], info: INFO } }),
    bundle: vi.fn().mockResolvedValue({ ok: true, value: BUNDLE }),
    setRoutePin: vi.fn().mockResolvedValue({ ok: true, value: { pin: 'agent' } }),
    sendRest: vi.fn().mockResolvedValue({ ok: true, value: makeRestExchange() }),
    send: vi.fn(),
    cancel: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }),
    record: vi.fn().mockResolvedValue({ ok: true, value: {} }),
    agentSend: vi.fn().mockResolvedValue({ ok: true, value: { ...makeRestExchange(), sentFrom: 'agent' } }),
    agentCancel: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }),
    domains: vi.fn().mockResolvedValue({ ok: true, value: { domains: [] } }),
  };
  const api = installWirebenchApi({
    request: {
      route: calls.route,
      bundle: calls.bundle,
      setRoutePin: calls.setRoutePin,
      sendRest: calls.sendRest,
      send: calls.send,
      cancel: calls.cancel,
      preflightRest: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }),
      preflight: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }),
    },
    exchanges: { recordAgentSend: calls.record },
  } as never);
  Object.assign(api, {
    env: { e2e: false, osTheme: 'dark', host: 'browser', capabilities, ...(agent ? { agent } : {}) },
    ...(agent
      ? {
          agent: {
            send: calls.agentSend,
            cancel: calls.agentCancel,
            cookies: { clear: vi.fn(), domains: calls.domains },
          },
        }
      : {}),
  });
  return calls;
}

const soapDraft: RequestDraft = {
  properties: REQUEST_PROPERTIES,
  attachments: [],
  assertions: [],
  id: 'soap-1',
  interfaceId: 'iface-1',
  bindingName: '{tns}B',
  operationName: 'Add',
  name: 'Request 1',
  slug: 'Request 1',
  operationSlug: 'Add',
  envelopeXml: '<Envelope/>',
  soapVersion: '1.1',
  endpointUrl: 'http://127.0.0.1:9000/soap',
  headers: [],
  order: 0,
};

let stopWatching: () => void = () => undefined;

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [] });
  useDraftsStore.getState().reset();
  useProblemsStore.setState({ items: [] });
  useSendRouteStore.setState({ byRequest: {}, agentStatus: 'none', agentVersion: undefined, cookieDomains: [] });
  useProjectStore.setState({
    apis: { 'api-1': restApiWire() },
    restRequests: { 'rest-1': restRequestWire() },
    requests: { 'soap-1': soapDraft },
    projectOf: { 'api-1': 'p1', 'rest-1': 'p1', 'soap-1': 'p1' },
  });
});

afterEach(() => {
  stopWatching();
  stopWatching = () => undefined;
  cleanup();
});

describe('a browser send', () => {
  it('routes to the agent: bundle on the server, send on the agent, recorded on the server, shown as a send', async () => {
    const calls = install(fakeAgent().env);
    await useExchangesStore.getState().sendRest('rest-1');

    expect(calls.route).toHaveBeenCalledWith({ projectId: 'p1', itemId: 'rest-1' });
    expect(calls.bundle).toHaveBeenCalledWith({ projectId: 'p1', itemId: 'rest-1' });
    const sendId = useExchangesStore.getState().restByRequest['rest-1']?.sendId;
    expect(calls.agentSend).toHaveBeenCalledWith({ sendId, bundle: BUNDLE });
    expect(calls.sendRest).not.toHaveBeenCalled();
    expect(calls.record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        itemId: 'rest-1',
        kind: 'rest',
        result: expect.objectContaining({ sentFrom: 'agent' }) as unknown,
      }),
    );
    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.status).toBe('done');
    expect(state?.exchange).toMatchObject({ sentFrom: 'agent' });
    expect(useExchangesStore.getState().log).toHaveLength(1);
  });

  it('routes a SOAP send to the agent the same way', async () => {
    const calls = install(fakeAgent().env);
    calls.agentSend.mockResolvedValue({
      ok: true,
      value: { sendId: 'x', durationMs: 1, problems: [], sentFrom: 'agent', http: makeRestExchange().http },
    });
    await useExchangesStore.getState().send('soap-1', true);
    expect(calls.bundle).toHaveBeenCalledWith({ projectId: 'p1', itemId: 'soap-1' });
    expect(calls.send).not.toHaveBeenCalled();
    expect(calls.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'soap', itemId: 'soap-1' }));
    expect(useExchangesStore.getState().byRequest['soap-1']?.status).toBe('done');
  });

  it('sends from the server when the route says server', async () => {
    const calls = install(fakeAgent().env);
    calls.route.mockResolvedValue({ ok: true, value: { route: 'server', info: INFO } });
    await useExchangesStore.getState().sendRest('rest-1');
    expect(calls.sendRest).toHaveBeenCalledTimes(1);
    expect(calls.bundle).not.toHaveBeenCalled();
    expect(calls.agentSend).not.toHaveBeenCalled();
  });

  it('fails with send-needs-agent, naming the needs, and offers to pair this machine when no agent is connected', async () => {
    const calls = install(fakeAgent('connecting').env);
    await useExchangesStore.getState().sendRest('rest-1');

    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.status).toBe('error');
    expect(state?.error).toMatchObject({ code: 'send-needs-agent', details: { needs: ['loopback-target'] } });
    expect(state?.error?.message).toContain('localhost');
    expect(calls.bundle).not.toHaveBeenCalled();
    expect(calls.sendRest).not.toHaveBeenCalled();
    // Not a Problem in the project: the pane and the toast say what to do.
    expect(useProblemsStore.getState().items).toEqual([]);

    const [, action] = vi.mocked(showToast).mock.calls.at(-1) ?? [];
    expect(action?.label).toBe('Pair this machine…');
    const open = vi.spyOn(useUiStore.getState(), 'openPreferences');
    action?.onClick();
    expect(open).toHaveBeenCalledWith('this-machine');
  });

  it('answers host-disconnected when the agent drops mid-send, and records nothing', async () => {
    const calls = install(fakeAgent().env);
    calls.agentSend.mockResolvedValue({ ok: false, error: { code: 'host-disconnected', message: 'agent gone' } });
    await useExchangesStore.getState().sendRest('rest-1');
    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.status).toBe('error');
    expect(state?.error?.code).toBe('host-disconnected');
    expect(calls.record).not.toHaveBeenCalled();
  });

  it('cancels an agent send on the agent', async () => {
    const calls = install(fakeAgent().env);
    let release: (value: unknown) => void = () => undefined;
    calls.agentSend.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const sending = useExchangesStore.getState().sendRest('rest-1');
    await vi.waitFor(() => expect(calls.agentSend).toHaveBeenCalled());
    await useExchangesStore.getState().cancelRest('rest-1');
    const sendId = useExchangesStore.getState().restByRequest['rest-1']?.sendId;
    expect(calls.agentCancel).toHaveBeenCalledWith({ sendId });
    expect(calls.cancel).not.toHaveBeenCalled();
    release({ ok: false, error: { code: 'aborted', message: 'aborted' } });
    await sending;
  });

  it('stops a send cancelled while its bundle is being built, before the agent gets it', async () => {
    const calls = install(fakeAgent().env);
    let release: (value: unknown) => void = () => undefined;
    calls.bundle.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const sending = useExchangesStore.getState().sendRest('rest-1');
    await vi.waitFor(() => expect(calls.bundle).toHaveBeenCalled());
    await useExchangesStore.getState().cancelRest('rest-1');
    release({ ok: true, value: BUNDLE });
    await sending;
    expect(calls.agentSend).not.toHaveBeenCalled();
    expect(useExchangesStore.getState().restByRequest['rest-1']?.error?.code).toBe('aborted');
  });

  it('sends to the agent when it holds cookies for the target host, though the server says server', async () => {
    const agent = fakeAgent();
    const calls = install(agent.env);
    calls.route.mockResolvedValue({ ok: true, value: { route: 'server', info: INFO } });
    calls.domains.mockResolvedValue({ ok: true, value: { domains: [{ domain: 'example.test', hostOnly: false }] } });
    stopWatching = watchAgent();
    await vi.waitFor(() => expect(useSendRouteStore.getState().cookieDomains).toHaveLength(1));

    await useExchangesStore.getState().sendRest('rest-1');
    expect(useSendRouteStore.getState().byRequest['rest-1']).toMatchObject({
      route: 'agent',
      needs: ['agent-cookies'],
    });
    expect(calls.agentSend).toHaveBeenCalledTimes(1);
    expect(calls.sendRest).not.toHaveBeenCalled();
    // Read again after the send: the jar may hold a new domain.
    await vi.waitFor(() => expect(calls.domains).toHaveBeenCalledTimes(2));
  });

  it('keeps a host-only cookie domain to that exact host', async () => {
    const calls = install(fakeAgent().env);
    calls.route.mockResolvedValue({ ok: true, value: { route: 'server', info: INFO } });
    calls.domains.mockResolvedValue({ ok: true, value: { domains: [{ domain: 'example.test', hostOnly: true }] } });
    stopWatching = watchAgent();
    await vi.waitFor(() => expect(useSendRouteStore.getState().cookieDomains).toHaveLength(1));
    await useExchangesStore.getState().sendRest('rest-1');
    expect(calls.sendRest).toHaveBeenCalledTimes(1);
  });
});

describe('the desktop', () => {
  it('asks for no route and sends as before', async () => {
    const calls = install(undefined);
    await useExchangesStore.getState().sendRest('rest-1');
    expect(calls.route).not.toHaveBeenCalled();
    expect(calls.sendRest).toHaveBeenCalledTimes(1);
  });

  it('shows no chip and no This machine section', () => {
    const calls = install(undefined);
    render(<RouteChip requestId="rest-1" />);
    expect(screen.queryByTestId('send-route-chip')).toBeNull();
    expect(calls.route).not.toHaveBeenCalled();
    expect(availableNav().flatMap((group) => group.sections.map((section) => section.id))).not.toContain(
      'this-machine',
    );
  });
});

describe('a tab with no pairing', () => {
  it('asks for no route, shows no chip, and sends from the server as before', async () => {
    const calls = install(fakeAgent('none').env);
    render(<RouteChip requestId="rest-1" />);
    expect(screen.queryByTestId('send-route-chip')).toBeNull();
    await useExchangesStore.getState().sendRest('rest-1');
    expect(calls.route).not.toHaveBeenCalled();
    expect(calls.sendRest).toHaveBeenCalledTimes(1);
  });

  it('routes again once paired', async () => {
    const calls = install(fakeAgent('connected').env);
    await useExchangesStore.getState().sendRest('rest-1');
    expect(calls.route).toHaveBeenCalledTimes(1);
    expect(calls.agentSend).toHaveBeenCalledTimes(1);
  });
});

function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe('the route chip', () => {
  it('shows Agent or Server for the route the next send takes', async () => {
    const calls = install(fakeAgent().env);
    render(<RouteChip requestId="rest-1" />);
    await vi.waitFor(() => expect(screen.getByTestId('send-route-chip').textContent).toBe('Agent'));
    expect(screen.getByTestId('send-route-chip').title).toContain('localhost');

    calls.route.mockResolvedValue({ ok: true, value: { route: 'server', info: INFO } });
    // An edit asks again, once the edits pause.
    vi.useFakeTimers();
    try {
      act(() => {
        useProjectStore.setState((state) => ({
          restRequests: { ...state.restRequests, 'rest-1': { ...restRequestWire(), url: '/other' } },
        }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(screen.getByTestId('send-route-chip').textContent).toBe('Server'));
    expect(calls.route).toHaveBeenCalledTimes(2);
  });

  it('pins the request to the agent, and the pin holds when the route is asked again', async () => {
    const calls = install(fakeAgent().env);
    calls.route.mockResolvedValue({ ok: true, value: { route: 'server', info: INFO } });
    render(<RouteChip requestId="rest-1" />);
    await vi.waitFor(() => expect(screen.getByTestId('send-route-chip').textContent).toBe('Server'));

    calls.route.mockResolvedValue({
      ok: true,
      value: { route: 'agent', needs: ['pinned'], info: { ...INFO, pins: { request: true, workspace: false } } },
    });
    openMenu(screen.getByTestId('send-route-chip'));
    fireEvent.click(screen.getByTestId('route-pin'));
    await vi.waitFor(() => expect(screen.getByTestId('send-route-chip').textContent).toBe('Agent'));
    expect(calls.setRoutePin).toHaveBeenCalledWith({ scope: 'request', id: 'rest-1', pin: 'agent' });

    openMenu(screen.getByTestId('send-route-chip'));
    expect(screen.getByTestId('route-unpin')).toBeTruthy();
    fireEvent.click(screen.getByTestId('route-unpin'));
    await vi.waitFor(() =>
      expect(calls.setRoutePin).toHaveBeenLastCalledWith({ scope: 'request', id: 'rest-1', pin: null }),
    );
  });

  it('pins the whole workspace by its server id', async () => {
    const calls = install(fakeAgent().env);
    calls.route.mockResolvedValue({ ok: true, value: { route: 'server', info: INFO } });
    render(<RouteChip requestId="rest-1" />);
    await vi.waitFor(() => expect(screen.getByTestId('send-route-chip').textContent).toBe('Server'));
    openMenu(screen.getByTestId('send-route-chip'));
    fireEvent.click(screen.getByTestId('route-pin-workspace'));
    await vi.waitFor(() =>
      expect(calls.setRoutePin).toHaveBeenCalledWith({ scope: 'workspace', id: 'ws-1', pin: 'agent' }),
    );
  });
});

describe('Settings → This machine', () => {
  it('is listed only where the tab has an agent', () => {
    install(fakeAgent().env);
    expect(availableNav().flatMap((group) => group.sections.map((section) => section.id))).toContain('this-machine');
  });

  it('shows the status, pairs with a code and both instructions, lists pairings and unpairs', async () => {
    const agent = fakeAgent('connecting');
    install(agent.env);
    stopWatching = watchAgent();
    render(<ThisMachineSection />);
    expect(screen.getByTestId('agent-status').dataset['status']).toBe('connecting');
    act(() => agent.set('connected'));
    expect(screen.getByTestId('agent-status').textContent).toBe('Connected (agent 7.0.0)');
    expect(screen.getByText(/sends requests from this server’s workspaces on your behalf/)).toBeTruthy();

    await vi.waitFor(() => expect(screen.getAllByTestId('agent-pairing-row')).toHaveLength(1));
    expect(agent.env.pairings).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('agent-pair'));
    await vi.waitFor(() => expect(screen.getByTestId('agent-pair-code').textContent).toContain('K7QW2P'));
    expect(agent.env.createPairingCode).toHaveBeenCalledTimes(1);
    const text = screen.getByTestId('agent-pair-code').textContent ?? '';
    expect(text).toContain('Pair this machine…');
    expect(text).toContain('wirebench agent pair K7QW2P --server https://acme.example.test');

    fireEvent.click(screen.getByTestId('agent-unpair'));
    await vi.waitFor(() => expect(agent.env.unpair).toHaveBeenCalledWith('pair-1'));
    await vi.waitFor(() => expect(screen.queryAllByTestId('agent-pairing-row')).toHaveLength(0));
  });
});

describe('History', () => {
  it('tags an entry with where it was sent from, and leaves a desktop entry untagged', async () => {
    const { SentFromTag } = await import('../../src/renderer/features/history/sent-from-tag.js');
    const { rerender } = render(<SentFromTag sentFrom="agent" />);
    expect(screen.getByTestId('history-origin').textContent).toBe('Agent');
    rerender(<SentFromTag sentFrom="server" />);
    expect(screen.getByTestId('history-origin').textContent).toBe('Server');
    rerender(<SentFromTag sentFrom={undefined} />);
    expect(screen.queryByTestId('history-origin')).toBeNull();
  });
});
