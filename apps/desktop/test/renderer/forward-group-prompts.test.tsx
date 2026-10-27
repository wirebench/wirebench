import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForwardPrompts } from '../../src/renderer/features/ssh/forwarding/bind-confirm-dialog.js';
import { startGroup } from '../../src/renderer/features/ssh/forwarding/forward-groups.js';
import { ForwardingPanel } from '../../src/renderer/features/ssh/forwarding/forwarding-view.js';
import { useForwardsStore } from '../../src/renderer/features/ssh/forwarding/forwards-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { TrustDialog } from '../../src/renderer/features/ssh/trust-dialog.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { ForwardStateWire } from '@wirebench/wire/forward-wire';
import type { HostsFileWire, ResolvedForwardWire, ResolvedHostWire } from '@wirebench/wire/ssh-wire';

/**
 * #589: Start group on rules that each need a prompt asks every prompt in turn (none replaces another), a
 * rule waiting on its prompt is not failed, a cancelled prompt leaves its rule stopped, and the group header
 * follows the group's state.
 */

const forward = { list: vi.fn(), start: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), freePort: vi.fn() };
const trustHostKey = vi.fn();

const ok = <T,>(value: T) => ({ ok: true as const, value });

const rule = (id: string, port: number, bind = '127.0.0.1'): ResolvedForwardWire => ({
  rule: { id, type: 'local', port, bind, target: { host: 'localhost', port }, autoStart: false },
  from: 'host',
  enabled: true,
});

const host = (id: string, forwards: ResolvedForwardWire[]): ResolvedHostWire =>
  ({
    id,
    name: id,
    address: `${id}.example`,
    tags: [],
    path: [],
    protected: { value: false, from: 'default' },
    ssh: {},
    forwards,
  }) as never;

const FILE: HostsFileWire = {
  version: 2,
  groups: [],
  hosts: [
    { id: 'db-1', name: 'db-1', address: 'db-1.example', tags: [], ssh: {} },
    { id: 'cache', name: 'cache', address: 'cache.example', tags: [], ssh: {} },
  ],
  forwardGroups: [
    {
      id: 'dev',
      name: 'Dev',
      rules: [
        { host: 'db-1', rule: 'pg' },
        { host: 'cache', rule: 'redis' },
      ],
    },
    { id: 'empty', name: 'Empty', rules: [] },
  ],
};

const portOf = (ruleId: string): number => (ruleId === 'pg' ? 5432 : 6379);
const state = (hostId: string, ruleId: string, status: ForwardStateWire['status']): ForwardStateWire => ({
  hostId,
  ruleId,
  origin: 'manual',
  port: portOf(ruleId),
  status,
});
const runningState = (hostId: string, ruleId: string) =>
  state(hostId, ruleId, {
    state: 'running',
    listening: { address: '127.0.0.1', port: portOf(ruleId) },
    connections: 0,
  });

interface StartRequest {
  readonly hostId: string;
  readonly ruleId: string;
  readonly confirmBind?: true;
}
interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** What main does with a start: a refusal shows on the rule as failed, a start that goes through runs. */
function mainAnswers(refuse: (request: StartRequest) => Refusal | undefined) {
  forward.start.mockImplementation((request: StartRequest) => {
    const refusal = refuse(request);
    if (refusal === undefined) {
      useForwardsStore.getState().apply(runningState(request.hostId, request.ruleId));
      return Promise.resolve(ok({}));
    }
    useForwardsStore.getState().apply(state(request.hostId, request.ruleId, { state: 'failed', error: refusal }));
    return Promise.resolve({ ok: false as const, error: refusal });
  });
}

/** Every host is new: each refuses its first start with its own key, then starts once trusted. */
function untrustedHosts() {
  const trusted = new Set<string>();
  trustHostKey.mockImplementation(({ host: address }: { host: string }) => {
    trusted.add(address);
    return Promise.resolve(ok({}));
  });
  mainAnswers(({ hostId }) =>
    trusted.has(`${hostId}.example:22`)
      ? undefined
      : {
          code: 'ssh-host-key-new',
          message: 'new key',
          details: { host: `${hostId}.example:22`, keyType: 'ssh-ed25519', fingerprint: `SHA256:${hostId}` },
        },
  );
}

/** Both rules bind 0.0.0.0, not confirmed on this machine: each refuses until started with `confirmBind`. */
function networkBinds() {
  mainAnswers(({ confirmBind }) =>
    confirmBind === true
      ? undefined
      : { code: 'ssh-forward-bind-unconfirmed', message: 'confirm the bind', details: { address: '0.0.0.0' } },
  );
}

const section = (id: string): HTMLElement => {
  const el = screen.getAllByTestId('forward-group').find((s) => s.dataset['group'] === id);
  if (el === undefined) throw new Error(`no section ${id}`);
  return el;
};
const statusOf = (id: string): string | null => within(section(id)).getByTestId('forward-group-status').textContent;
const startedRules = (): string[] =>
  forward.start.mock.calls.map((c) => {
    const r = c[0] as StartRequest;
    return `${r.hostId}/${r.ruleId}${r.confirmBind ? ' (confirmed)' : ''}`;
  });

function renderView() {
  render(
    <>
      <ForwardingPanel />
      <TrustDialog />
      <ForwardPrompts />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  forward.list.mockResolvedValue(ok({ forwards: [] }));
  forward.stop.mockResolvedValue(ok({}));
  Object.defineProperty(window, 'wirebench', {
    configurable: true,
    value: { forward, ssh: { trustHostKey }, on: () => () => undefined },
  });
  useForwardsStore.getState().reset();
  useHostsStore.setState({
    resolved: [host('db-1', [rule('pg', 5432, '0.0.0.0')]), host('cache', [rule('redis', 6379, '0.0.0.0')])],
    file: FILE,
    loaded: true,
    problems: [],
    trustPrompt: null,
    trustQueue: [],
  });
  useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
});
afterEach(cleanup);

describe('Start group on a group of two untrusted hosts', () => {
  it('asks to trust each host in turn, then starts both rules', async () => {
    untrustedHosts();
    renderView();
    await userEvent.click(within(section('dev')).getByRole('button', { name: 'Start group' }));

    // The second refusal queues behind the first: neither rule is failed while they wait.
    const dialog = await screen.findByTestId('trust-dialog');
    expect(within(dialog).getByText('SHA256:db-1')).toBeTruthy();
    expect(useHostsStore.getState().trustQueue.map((p) => p.hostId)).toEqual(['cache']);
    expect(statusOf('dev')).toBe('0 of 2 running');
    expect(screen.queryByTestId('forward-group-failed')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
    await waitFor(() => {
      expect(within(screen.getByTestId('trust-dialog')).getByText('SHA256:cache')).toBeTruthy();
    });
    await waitFor(() => {
      expect(statusOf('dev')).toBe('1 of 2 running');
    });

    await userEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
    await waitFor(() => {
      expect(statusOf('dev')).toBe('2 of 2 running');
    });
    expect(screen.queryByTestId('trust-dialog')).toBeNull();
    expect(trustHostKey).toHaveBeenCalledTimes(2);
    expect(startedRules()).toEqual(['db-1/pg', 'cache/redis', 'db-1/pg', 'cache/redis']);
    expect(useForwardsStore.getState().startErrors).toEqual({});
  });

  it('a cancelled trust prompt leaves its rule stopped, not failed, and the next prompt still asks', async () => {
    untrustedHosts();
    renderView();
    await act(async () => {
      await startGroup('dev');
    });
    await userEvent.click(within(await screen.findByTestId('trust-dialog')).getByRole('button', { name: 'Cancel' }));

    // db-1's start is cleared in main and here; cache's prompt shows next.
    await waitFor(() => {
      expect(forward.stop).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg' });
    });
    expect(within(screen.getByTestId('trust-dialog')).getByText('SHA256:cache')).toBeTruthy();
    expect(useForwardsStore.getState().byKey['db-1/pg']).toBeUndefined();
    expect(useForwardsStore.getState().startErrors['db-1/pg']).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
    await waitFor(() => {
      expect(statusOf('dev')).toBe('1 of 2 running');
    });
    expect(screen.queryByTestId('forward-group-failed')).toBeNull();
  });

  it('two rules on one untrusted host share one prompt: trusting it starts both', async () => {
    useHostsStore.setState({
      resolved: [host('db-1', [rule('pg', 5432), rule('redis', 6379)])],
      file: {
        ...FILE,
        forwardGroups: [
          {
            id: 'dev',
            name: 'Dev',
            rules: [
              { host: 'db-1', rule: 'pg' },
              { host: 'db-1', rule: 'redis' },
            ],
          },
        ],
      },
    });
    untrustedHosts();
    renderView();
    await act(async () => {
      await startGroup('dev');
    });
    expect(useHostsStore.getState().trustQueue).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Trust and connect' }));
    await waitFor(() => {
      expect(statusOf('dev')).toBe('2 of 2 running');
    });
    expect(trustHostKey).toHaveBeenCalledOnce();
  });
});

describe('Start group on a group of two network binds', () => {
  it('asks to confirm each bind in turn, then starts both rules', async () => {
    networkBinds();
    renderView();
    await userEvent.click(within(section('dev')).getByRole('button', { name: 'Start group' }));

    const dialog = await screen.findByTestId('forward-bind-dialog');
    expect(dialog.textContent).toContain('db-1 · pg will be reachable from other machines at 0.0.0.0:5432');
    expect(dialog.textContent).toContain('1 more to confirm after this one.');
    expect(statusOf('dev')).toBe('0 of 2 running');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(screen.getByTestId('forward-bind-dialog').textContent).toContain('cache · redis');
    });
    expect(screen.getByTestId('forward-bind-dialog').textContent).not.toContain('more to confirm');

    await userEvent.click(within(screen.getByTestId('forward-bind-dialog')).getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(statusOf('dev')).toBe('2 of 2 running');
    });
    expect(screen.queryByTestId('forward-bind-dialog')).toBeNull();
    expect(startedRules()).toEqual(['db-1/pg', 'cache/redis', 'db-1/pg (confirmed)', 'cache/redis (confirmed)']);
  });

  it('a cancelled bind prompt leaves its rule stopped and asks the next', async () => {
    networkBinds();
    renderView();
    await act(async () => {
      await startGroup('dev');
    });
    await userEvent.click(
      within(await screen.findByTestId('forward-bind-dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => {
      expect(forward.stop).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg' });
    });
    expect(screen.getByTestId('forward-bind-dialog').textContent).toContain('cache · redis');
    expect(useForwardsStore.getState().byKey['db-1/pg']).toBeUndefined();
    expect(useForwardsStore.getState().waiting).toEqual({ 'cache/redis': true });
    expect(statusOf('dev')).toBe('0 of 2 running');
  });
});

describe('the group header follows its state', () => {
  it('an empty group says No rules and offers no Start', () => {
    renderView();
    expect(statusOf('empty')).toBe('No rules');
    expect(within(section('empty')).queryByRole('button', { name: /Start/ })).toBeNull();
  });

  it('a partly running group offers Start N more beside Stop group', async () => {
    networkBinds();
    useForwardsStore.getState().apply(runningState('db-1', 'pg'));
    renderView();
    const dev = section('dev');
    expect(within(dev).queryByRole('button', { name: 'Start group' })).toBeNull();
    expect(within(dev).getByRole('button', { name: 'Stop group' })).toBeTruthy();
    await userEvent.click(within(dev).getByRole('button', { name: 'Start 1 more' }));
    expect(startedRules()).toEqual(['cache/redis']);
  });

  it('the failed count is a link to the Failed rows', async () => {
    useForwardsStore.getState().apply(runningState('db-1', 'pg'));
    useForwardsStore
      .getState()
      .apply(state('cache', 'redis', { state: 'failed', error: { code: 'ssh-auth-failed', message: 'refused' } }));
    renderView();
    expect(statusOf('dev')).toBe('1 of 2 running · 1 failed');
    await userEvent.click(screen.getByTestId('forward-group-failed'));
    expect(screen.getByRole('button', { name: 'Failed' }).getAttribute('aria-pressed')).toBe('true');
    expect(
      within(section('dev'))
        .getAllByTestId('forward-row')
        .map((r) => r.dataset['forward']),
    ).toEqual(['cache/redis']);
  });
});
