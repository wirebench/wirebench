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
import { ProtectedSendDialog } from '../../src/renderer/features/request-editor/protected-send-dialog.js';
import { HISTORY_BODY_MAX_CHARS } from '@wirebench/wire/history-body';
import { ThisMachineSection } from '../../src/renderer/features/preferences/sections/this-machine-section.js';
import { availableNav } from '../../src/renderer/features/preferences/settings-model.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeExchange, makeRestExchange } from '../mocks/exchange-fixtures.js';
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
      agentId: '3f9c2a71-0d4e-4b8a-9e11-5a6b7c8d9e0f',
      sshOptIn: false,
      createdAt: '2026-10-29T10:00:00Z',
      lastSeenAt: '2026-10-29T11:00:00Z',
    },
    {
      id: 'pair-2',
      port: 47615,
      agentId: 'b2e8d4f0-1111-4c2d-8e3f-000000000000',
      sshOptIn: false,
      createdAt: '2026-10-20T09:00:00Z',
      lastSeenAt: '2026-10-21T09:00:00Z',
    },
  ];
  const refusedIds = new Set<string>();
  const env = {
    serverOrigin: 'https://acme.example.test',
    status: () => status,
    version: () => (status === 'connected' ? '7.0.0' : undefined),
    refused: (id: string) => refusedIds.has(id),
    // A connected agent that covers every need, unless a test says otherwise.
    selectFor: vi.fn<AgentEnv['selectFor']>(() => Promise.resolve({ connected: status === 'connected', missing: [] })),
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
    refuse(id: string) {
      refusedIds.add(id);
    },
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
  readonly recordFailure: ReturnType<typeof vi.fn>;
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
    recordFailure: vi.fn().mockResolvedValue({ ok: true, value: {} }),
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
    exchanges: { recordAgentSend: calls.record, recordAgentFailure: calls.recordFailure },
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

  it('asks for an agent that resolves team secrets, and says to use the desktop app when none does', async () => {
    const agent = fakeAgent();
    const calls = install(agent.env);
    calls.route.mockResolvedValue({
      ok: true,
      value: { route: 'agent', needs: ['team-secret', 'loopback-target'], info: INFO },
    });
    await useExchangesStore.getState().sendRest('rest-1');
    expect(agent.env.selectFor).toHaveBeenLastCalledWith(['team-secrets']);
    expect(calls.agentSend).toHaveBeenCalledTimes(1);

    // Only `wirebench agent` is paired here: it lacks team secrets, so nothing is built or sent.
    agent.env.selectFor.mockResolvedValue({ connected: true, missing: ['team-secrets'] });
    calls.bundle.mockClear();
    calls.agentSend.mockClear();
    await useExchangesStore.getState().sendRest('rest-1');
    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.status).toBe('error');
    expect(state?.error?.code).toBe('team-secret-needs-approval');
    expect(state?.error?.message).toContain('desktop app');
    expect(calls.bundle).not.toHaveBeenCalled();
    expect(calls.agentSend).not.toHaveBeenCalled();
  });

  it('asks for no capability for a send any agent can make', async () => {
    const agent = fakeAgent();
    install(agent.env);
    await useExchangesStore.getState().sendRest('rest-1');
    expect(agent.env.selectFor).toHaveBeenLastCalledWith([]);
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

  it.each(['rest', 'soap'] as const)(
    'stops a %s send cancelled while its route is asked: nothing is sent anywhere',
    async (kind) => {
      const calls = install(fakeAgent().env);
      let release: (value: unknown) => void = () => undefined;
      calls.route.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const store = useExchangesStore.getState();
      const sending = kind === 'rest' ? store.sendRest('rest-1') : store.send('soap-1', true);
      await vi.waitFor(() => expect(calls.route).toHaveBeenCalled());
      await (kind === 'rest' ? store.cancelRest('rest-1') : store.cancel('soap-1'));
      release({ ok: true, value: { route: 'server', info: INFO } });
      await sending;
      expect(calls.sendRest).not.toHaveBeenCalled();
      expect(calls.send).not.toHaveBeenCalled();
      expect(calls.bundle).not.toHaveBeenCalled();
      expect(calls.agentSend).not.toHaveBeenCalled();
      // The server had nothing of it to cancel.
      expect(calls.cancel).not.toHaveBeenCalled();
      const state =
        kind === 'rest'
          ? useExchangesStore.getState().restByRequest['rest-1']
          : useExchangesStore.getState().byRequest['soap-1'];
      expect(state?.error?.code).toBe('aborted');
    },
  );

  it('stops a send cancelled while its unsaved edit is committed', async () => {
    const calls = install(fakeAgent().env);
    let release: (value: boolean) => void = () => undefined;
    const commit = vi.spyOn(useProjectStore.getState(), 'commitRestRequest').mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const sending = useExchangesStore.getState().sendRest('rest-1');
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    await useExchangesStore.getState().cancelRest('rest-1');
    release(true);
    await sending;
    commit.mockRestore();
    expect(calls.route).not.toHaveBeenCalled();
    expect(calls.sendRest).not.toHaveBeenCalled();
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
  it('still asks for the route and shows the chip: a private target the server reaches goes from the server', async () => {
    const calls = install(fakeAgent('none').env);
    calls.route.mockResolvedValue({ ok: true, value: { route: 'server', info: INFO } });
    render(<RouteChip requestId="rest-1" />);
    await vi.waitFor(() => expect(screen.getByTestId('send-route-chip').textContent).toBe('Server'));
    await useExchangesStore.getState().sendRest('rest-1');
    expect(calls.sendRest).toHaveBeenCalledTimes(1);
  });

  it('answers send-needs-agent with Pair this machine for a localhost target', async () => {
    const calls = install(fakeAgent('none').env);
    await useExchangesStore.getState().sendRest('rest-1');
    expect(calls.route).toHaveBeenCalledTimes(1);
    expect(calls.sendRest).not.toHaveBeenCalled();
    expect(useExchangesStore.getState().restByRequest['rest-1']?.error).toMatchObject({
      code: 'send-needs-agent',
      details: { needs: ['loopback-target'] },
    });
    const [, action] = vi.mocked(showToast).mock.calls.at(-1) ?? [];
    expect(action?.label).toBe('Pair this machine…');
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
    // What pairing trusts the server with, the browser's prompt and Safari, where the pairing is offered.
    const notes = screen.getByTestId('agent-pair-notes').textContent ?? '';
    expect(notes).toContain(
      'A paired server can send requests from this machine on your behalf, including to addresses on this machine’s network.',
    );
    expect(notes).toContain('local network access');
    expect(notes).toContain('allow it');
    expect(notes).toContain('Safari cannot reach an agent on this machine from an https:// page');
    expect(notes).toContain('pair the Wirebench desktop app');

    await vi.waitFor(() => expect(screen.getAllByTestId('agent-pairing-row')).toHaveLength(2));
    // Two machines told apart by their agent id and when they were paired.
    const rows = screen.getAllByTestId('agent-pairing-row').map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('3f9c2a71');
    expect(rows[1]).toContain('b2e8d4f0');
    expect(rows[0]).toContain(new Date('2026-10-29T10:00:00Z').toLocaleDateString());
    expect(agent.env.pairings).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('agent-pair'));
    await vi.waitFor(() => expect(screen.getByTestId('agent-pair-code').textContent).toContain('K7QW2P'));
    expect(agent.env.createPairingCode).toHaveBeenCalledTimes(1);
    const text = screen.getByTestId('agent-pair-code').textContent ?? '';
    expect(text).toContain('Pair this machine…');
    // Still said beside the code.
    expect(screen.getByTestId('agent-pair-notes').textContent).toContain('on your behalf');
    expect(text).toContain('wirebench agent pair K7QW2P --server https://acme.example.test');

    fireEvent.click(screen.getAllByTestId('agent-unpair')[0]!);
    await vi.waitFor(() => expect(agent.env.unpair).toHaveBeenCalledWith('pair-1'));
    await vi.waitFor(() => expect(screen.queryAllByTestId('agent-pairing-row')).toHaveLength(1));
  });
});

describe('Settings → This machine, refused', () => {
  it("says the machine's agent refused the pairing, on the status and on its row", async () => {
    const agent = fakeAgent('connecting');
    agent.refuse('pair-1');
    install(agent.env);
    stopWatching = watchAgent();
    render(<ThisMachineSection />);
    act(() => agent.set('refused'));
    expect(screen.getByTestId('agent-status').textContent).toBe('Refused by this machine’s agent');
    await vi.waitFor(() => expect(screen.getAllByTestId('agent-pairing-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('agent-pairing-row');
    expect(rows[0]?.textContent).toContain('Refused by this machine’s agent');
    expect(rows[1]?.textContent).not.toContain('Refused');
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

describe('an agent send, further', () => {
  const NEEDS_CONFIRMATION = {
    ok: false,
    error: {
      code: 'needs-confirmation',
      message: '"Production" is a protected environment: confirm the send first',
      details: { environment: 'Production' },
    },
  };

  it('asks before a protected environment, and sends once the person confirms', async () => {
    const calls = install(fakeAgent().env);
    calls.bundle.mockResolvedValueOnce(NEEDS_CONFIRMATION);
    render(<ProtectedSendDialog />);
    const sending = useExchangesStore.getState().sendRest('rest-1');

    const dialog = await screen.findByTestId('protected-send-dialog');
    expect(dialog.textContent).toContain('Send to Production?');
    expect(dialog.textContent).toContain('"Production" is a protected environment');
    expect(calls.agentSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('protected-send-confirm'));
    await act(async () => {
      await sending;
    });

    expect(calls.bundle).toHaveBeenNthCalledWith(2, { projectId: 'p1', itemId: 'rest-1', confirmed: true });
    expect(calls.agentSend).toHaveBeenCalledTimes(1);
    expect(useExchangesStore.getState().restByRequest['rest-1']?.status).toBe('done');
  });

  it('sends nothing when the person declines', async () => {
    const calls = install(fakeAgent().env);
    calls.bundle.mockResolvedValueOnce(NEEDS_CONFIRMATION);
    render(<ProtectedSendDialog />);
    const sending = useExchangesStore.getState().sendRest('rest-1');
    await screen.findByTestId('protected-send-dialog');
    fireEvent.click(screen.getByTestId('protected-send-cancel'));
    await act(async () => {
      await sending;
    });

    expect(calls.bundle).toHaveBeenCalledTimes(1);
    expect(calls.agentSend).not.toHaveBeenCalled();
    expect(calls.record).not.toHaveBeenCalled();
    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.error).toMatchObject({ code: 'send-declined', details: { environments: ['Production'] } });
    // The person's own choice: not a Problem.
    expect(useProblemsStore.getState().items).toEqual([]);
  });

  it('says a host the server cannot resolve may be one only this network knows, and offers to pair', async () => {
    const calls = install(fakeAgent('none').env);
    calls.route.mockResolvedValue({
      ok: true,
      value: { route: 'agent', needs: ['private-target'], detail: { reason: 'unresolved' }, info: INFO },
    });
    await useExchangesStore.getState().sendRest('rest-1');
    const error = useExchangesStore.getState().restByRequest['rest-1']?.error;
    expect(error).toMatchObject({
      code: 'send-needs-agent',
      details: { needs: ['private-target'], reason: 'unresolved' },
    });
    expect(error?.message).toContain('does not resolve from the server');
    expect(error?.message).toContain('only your network knows');
    const [message, action] = vi.mocked(showToast).mock.calls.at(-1) ?? [];
    expect(message).toContain('does not resolve from the server');
    expect(action?.label).toBe('Pair this machine…');
  });

  it('uploads a 30 MiB response trimmed as History trims it, and shows the whole of it', async () => {
    const calls = install(fakeAgent().env);
    const whole = 'y'.repeat(30 * 1024 * 1024);
    const big = makeRestExchange({ text: whole, sentFrom: 'agent' });
    calls.agentSend.mockResolvedValue({ ok: true, value: big });
    await useExchangesStore.getState().sendRest('rest-1');

    const [request] = calls.record.mock.calls[0] as [
      { result: { text: string; http: { rawResponseBase64: string; bodyBase64: string } }; responseBytes: number },
    ];
    expect(request.result.text.startsWith('y'.repeat(HISTORY_BODY_MAX_CHARS))).toBe(true);
    expect(request.result.text.length).toBeLessThan(HISTORY_BODY_MAX_CHARS + 64);
    expect(request.result.text).toMatch(/… truncated, \d+ more characters$/);
    expect(request.result.http.bodyBase64).toBe('');
    expect(request.responseBytes).toBe(Buffer.from(big.http.rawResponseBase64, 'base64').byteLength);
    // Well under the server socket's 32 MiB.
    expect(JSON.stringify(request).length).toBeLessThan(2 * 1024 * 1024);
    expect(useExchangesStore.getState().restByRequest['rest-1']?.exchange?.text.length).toBe(whole.length);
  }, 60_000); // builds and trims 30 MiB of text, which takes several seconds on CI runners

  it('has the server record a failed agent send, under the tab’s send id', async () => {
    const calls = install(fakeAgent().env);
    const row = {
      sendId: 'host-own-id',
      protocol: 'rest',
      requestId: 'rest-1',
      request: { url: 'http://127.0.0.1:1/echo', method: 'GET', headers: {} },
      startedAt: '2026-10-29T10:00:00.000Z',
      durationMs: 3,
      error: { code: 'connection-refused', message: 'Connection refused.' },
    };
    calls.agentSend.mockResolvedValue({
      ok: false,
      error: { code: 'connection-refused', message: 'Connection refused.', details: { failure: row } },
    });
    await useExchangesStore.getState().sendRest('rest-1');
    const sendId = useExchangesStore.getState().restByRequest['rest-1']?.sendId;
    expect(calls.recordFailure).toHaveBeenCalledWith({
      projectId: 'p1',
      itemId: 'rest-1',
      kind: 'rest',
      failure: { ...row, sendId },
    });
    expect(calls.record).not.toHaveBeenCalled();
    expect(useExchangesStore.getState().restByRequest['rest-1']?.error?.code).toBe('connection-refused');
  });
});

describe('a failed agent send with a large request body', () => {
  it('has its row recorded with the raw request cut as History cuts it, under the cap', async () => {
    const calls = install(fakeAgent().env);
    const body = 'q'.repeat(5 * 1024 * 1024);
    const raw = Buffer.from(`POST /upload HTTP/1.1\r\nhost: 127.0.0.1:1\r\n\r\n${body}`).toString('base64');
    const row = {
      sendId: 'host-own-id',
      protocol: 'rest',
      requestId: 'rest-1',
      request: { url: 'http://127.0.0.1:1/upload', method: 'POST', headers: {} },
      rawRequestBase64: raw,
      startedAt: '2026-10-29T10:00:00.000Z',
      durationMs: 3,
      error: { code: 'connection-reset', message: 'Connection reset.' },
    };
    calls.agentSend.mockResolvedValue({
      ok: false,
      error: { code: 'connection-reset', message: 'Connection reset.', details: { failure: row } },
    });
    await useExchangesStore.getState().sendRest('rest-1');

    const [request] = calls.recordFailure.mock.calls[0] as [{ failure: { rawRequestBase64: string } }];
    const sentRaw = Buffer.from(request.failure.rawRequestBase64, 'base64').toString('utf8');
    expect(sentRaw.startsWith('POST /upload HTTP/1.1\r\nhost: 127.0.0.1:1\r\n\r\n')).toBe(true);
    expect(sentRaw).toMatch(/… truncated, \d+ more characters$/);
    // Under the record schema's cap (`AGENT_RECORD_MAX_BODY_CHARS`, 2 Mi characters).
    expect(request.failure.rawRequestBase64.length).toBeLessThan(2 * 1024 * 1024);
    expect(request.failure.rawRequestBase64.length).toBeLessThan(HISTORY_BODY_MAX_CHARS * 2);
  });
});

describe('a server send under a protected environment', () => {
  const NEEDS = {
    ok: false,
    error: {
      code: 'needs-confirmation',
      message: '"Production" is a protected environment: confirm the send first',
      details: { environment: 'Production' },
    },
  };
  const SERVER_ROUTE = { ok: true, value: { route: 'server', info: INFO } };

  it('asks, then sends the REST request once more, confirmed', async () => {
    const calls = install(fakeAgent().env);
    calls.route.mockResolvedValue(SERVER_ROUTE);
    calls.sendRest.mockResolvedValueOnce(NEEDS);
    render(<ProtectedSendDialog />);
    const sending = useExchangesStore.getState().sendRest('rest-1');
    await screen.findByTestId('protected-send-dialog');
    fireEvent.click(screen.getByTestId('protected-send-confirm'));
    await act(async () => {
      await sending;
    });
    const sendId = useExchangesStore.getState().restByRequest['rest-1']?.sendId;
    expect(calls.sendRest).toHaveBeenCalledTimes(2);
    expect(calls.sendRest).toHaveBeenNthCalledWith(1, { sendId, requestId: 'rest-1' });
    expect(calls.sendRest).toHaveBeenNthCalledWith(2, { sendId, requestId: 'rest-1', confirmed: true });
    expect(useExchangesStore.getState().restByRequest['rest-1']?.status).toBe('done');
  });

  it('sends nothing more when the person declines', async () => {
    const calls = install(fakeAgent().env);
    calls.route.mockResolvedValue(SERVER_ROUTE);
    calls.sendRest.mockResolvedValueOnce(NEEDS);
    render(<ProtectedSendDialog />);
    const sending = useExchangesStore.getState().sendRest('rest-1');
    await screen.findByTestId('protected-send-dialog');
    fireEvent.click(screen.getByTestId('protected-send-cancel'));
    await act(async () => {
      await sending;
    });
    expect(calls.sendRest).toHaveBeenCalledTimes(1);
    expect(useExchangesStore.getState().restByRequest['rest-1']?.error).toMatchObject({ code: 'send-declined' });
    expect(useProblemsStore.getState().items).toEqual([]);
  });

  it('asks for a SOAP send too, and resends it confirmed', async () => {
    const calls = install(fakeAgent().env);
    calls.route.mockResolvedValue(SERVER_ROUTE);
    calls.send.mockResolvedValueOnce(NEEDS).mockResolvedValueOnce({ ok: true, value: makeExchange() });
    render(<ProtectedSendDialog />);
    const sending = useExchangesStore.getState().send('soap-1', true);
    await screen.findByTestId('protected-send-dialog');
    fireEvent.click(screen.getByTestId('protected-send-confirm'));
    await act(async () => {
      await sending;
    });
    expect(calls.send).toHaveBeenCalledTimes(2);
    expect(calls.send.mock.calls[0]?.[0]).not.toHaveProperty('confirmed');
    expect(calls.send.mock.calls[1]?.[0]).toMatchObject({ requestId: 'soap-1', confirmed: true });
  });

  it('on the desktop, sends once and never asks: its host asks natively', async () => {
    const calls = install(undefined);
    await useExchangesStore.getState().sendRest('rest-1');
    expect(calls.sendRest).toHaveBeenCalledTimes(1);
    expect(calls.sendRest.mock.calls[0]?.[0]).not.toHaveProperty('confirmed');
  });
});
