import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNetworkBind as packageIsNetworkBind } from '@wirebench/ssh';
import { ForwardPrompts } from '../../src/renderer/features/ssh/forwarding/bind-confirm-dialog.js';
import { isNetworkBind } from '../../src/renderer/features/ssh/forwarding/forward-format.js';
import { askForPort, startForward } from '../../src/renderer/features/ssh/forwarding/forward-actions.js';
import { ForwardingPanel, HostForwards } from '../../src/renderer/features/ssh/forwarding/forwarding-view.js';
import { useForwardsStore } from '../../src/renderer/features/ssh/forwarding/forwards-store.js';
import { SshStatusItem } from '../../src/renderer/features/ssh/forwarding/ssh-status-item.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { TrustDialog } from '../../src/renderer/features/ssh/trust-dialog.js';
import { StatusBar } from '../../src/renderer/shell/status-bar.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { ForwardStateWire } from '../../src/shared/forward-wire.js';
import type { HostsFileWire, ResolvedForwardWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';

const forward = {
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  stopAll: vi.fn(),
  freePort: vi.fn(),
};
const trustHostKey = vi.fn();

const ok = <T,>(value: T) => ({ ok: true as const, value });
const refused = (code: string, message: string, details?: Record<string, unknown>) => ({
  ok: false as const,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

const rule = (
  id: string,
  over: Partial<ResolvedForwardWire['rule']> = {},
  rest: Partial<Omit<ResolvedForwardWire, 'rule'>> = {},
): ResolvedForwardWire => ({
  rule: {
    id,
    type: 'local',
    port: 5432,
    bind: '127.0.0.1',
    target: { host: 'localhost', port: 5432 },
    autoStart: false,
    ...over,
  },
  from: 'host',
  enabled: true,
  ...rest,
});

const host = (id: string, name: string, forwards: ResolvedForwardWire[]): ResolvedHostWire =>
  ({
    id,
    name,
    address: `${id}.example`,
    tags: [],
    path: [],
    protected: { value: false, from: 'default' },
    ssh: {},
    forwards,
  }) as never;

const FILE: HostsFileWire = {
  version: 1,
  groups: [{ id: 'prod', name: 'Production', tags: [], ssh: {}, groups: [], hosts: [] }],
  hosts: [],
};

const DB1 = host('db-1', 'db-1', [
  rule('pg', { autoStart: true }),
  rule(
    'grafana',
    { port: 3000, target: { host: 'localhost', port: 3000 } },
    { from: { group: 'prod' }, enabled: false, offBy: 'host' },
  ),
  rule('admin', { port: 8080, bind: '0.0.0.0', target: { host: 'localhost', port: 80 } }),
]);
const BASTION = host('bastion', 'bastion', [rule('socks', { type: 'dynamic', port: 1080, target: undefined })]);

const running = (hostId: string, ruleId: string, port: number): ForwardStateWire => ({
  hostId,
  ruleId,
  origin: 'manual',
  port,
  status: { state: 'running', listening: { address: '127.0.0.1', port }, connections: 1 },
});
const failed = (hostId: string, ruleId: string, port: number): ForwardStateWire => ({
  hostId,
  ruleId,
  origin: 'manual',
  port,
  status: { state: 'failed', error: { code: 'ssh-forward-port-in-use', message: 'Port 1080 is taken' } },
});

const rowOf = (key: string): HTMLElement => {
  const row = screen.getAllByTestId('forward-row').find((el) => el.dataset['forward'] === key);
  if (row === undefined) throw new Error(`no row ${key}`);
  return row;
};

beforeEach(() => {
  vi.clearAllMocks();
  forward.list.mockResolvedValue(ok({ forwards: [] }));
  forward.start.mockResolvedValue(ok({}));
  forward.stop.mockResolvedValue(ok({}));
  forward.stopAll.mockResolvedValue(ok({}));
  forward.freePort.mockResolvedValue(ok({ port: 5433 }));
  trustHostKey.mockResolvedValue(ok({}));
  Object.defineProperty(window, 'wirebench', {
    configurable: true,
    value: {
      forward,
      ssh: { trustHostKey },
      app: { version: vi.fn().mockResolvedValue(refused('x', 'x')) },
      theme: { get: vi.fn().mockResolvedValue(ok({ os: 'dark' })) },
      on: () => () => undefined,
    },
  });
  useForwardsStore.getState().reset();
  useHostsStore.setState({ resolved: [DB1, BASTION], file: FILE, loaded: true, trustPrompt: null, homeView: 'hosts' });
  useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
});
afterEach(cleanup);

describe('the Port forwarding view', () => {
  it('lists one row per resolved rule of every host with its type, route, provenance and badges', () => {
    render(<ForwardingPanel />);
    expect(screen.getAllByTestId('forward-row').map((row) => row.dataset['forward'])).toEqual([
      'db-1/pg',
      'db-1/grafana',
      'db-1/admin',
      'bastion/socks',
    ]);
    const pg = rowOf('db-1/pg');
    expect(pg.textContent).toContain('Local');
    expect(pg.textContent).toContain('127.0.0.1:5432 → localhost:5432');
    expect(pg.textContent).toContain('defined on this host');
    expect(within(pg).getByText('auto')).toBeDefined();
    expect(within(pg).queryByText('network')).toBeNull();
    expect(within(rowOf('db-1/admin')).getByText('network')).toBeDefined();
    const socks = rowOf('bastion/socks');
    expect(socks.textContent).toContain('Dynamic');
    expect(socks.textContent).toContain('127.0.0.1:1080 → SOCKS');
    expect(within(socks).getByRole('button', { name: 'Start' })).toBeDefined();
  });

  it('greys an off rule with the level that switched it off and offers no action', () => {
    render(<ForwardingPanel />);
    const grafana = rowOf('db-1/grafana');
    expect(grafana.dataset['state']).toBe('off');
    expect(grafana.className).toContain('opacity-50');
    expect(grafana.textContent).toContain('off on this host');
    expect(within(grafana).queryAllByRole('button')).toHaveLength(0);
  });

  it('names the host group a rule came from as a host group', () => {
    useHostsStore.setState({
      resolved: [host('db-2', 'db-2', [rule('grafana', { port: 3000 }, { from: { group: 'prod' } })])],
    });
    render(<ForwardingPanel />);
    expect(rowOf('db-2/grafana').textContent).toContain('defined on host group Production');
  });

  it('the Running and Failed chips filter the rows; the box filters by port', () => {
    act(() => {
      useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
      useForwardsStore.getState().apply(failed('bastion', 'socks', 1080));
    });
    render(<ForwardingPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Running' }));
    expect(screen.getAllByTestId('forward-row').map((row) => row.dataset['forward'])).toEqual(['db-1/pg']);
    expect(within(rowOf('db-1/pg')).getByRole('button', { name: 'Stop' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Failed' }));
    expect(screen.getAllByTestId('forward-row').map((row) => row.dataset['forward'])).toEqual(['bastion/socks']);
    const socks = rowOf('bastion/socks');
    expect(within(socks).getByRole('button', { name: 'Retry' })).toBeDefined();
    expect(within(socks).getByRole('alert').textContent).toBe('Port 1080 is taken');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Filter forwards'), { target: { value: '8080' } });
    expect(screen.getAllByTestId('forward-row').map((row) => row.dataset['forward'])).toEqual(['db-1/admin']);
  });

  it('a filter that hides every rule offers Clear search', () => {
    render(<ForwardingPanel />);
    fireEvent.change(screen.getByLabelText('Filter forwards'), { target: { value: 'nothing-like-this' } });
    expect(screen.queryAllByTestId('forward-row')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getAllByTestId('forward-row')).toHaveLength(4);
  });

  it('with no rule anywhere, the empty state offers New rule…', () => {
    useHostsStore.setState({ resolved: [host('db-2', 'db-2', [])] });
    render(<ForwardingPanel />);
    const empty = screen.getByTestId('forwards-empty');
    fireEvent.click(within(empty).getByRole('button', { name: /New rule/ }));
    expect(screen.getByTestId('new-rule-dialog')).toBeDefined();
  });

  it('New rule… adds the rule to the picked host and saves hosts.yaml', async () => {
    const withHosts: HostsFileWire = {
      ...FILE,
      hosts: [
        { id: 'db-1', name: 'db-1', address: 'db-1.example', tags: [], ssh: {} },
        { id: 'bastion', name: 'bastion', address: 'bastion.example', tags: [], ssh: {} },
      ],
    };
    const saveHosts = vi.fn().mockResolvedValue(ok({ file: withHosts, resolved: [DB1, BASTION], problems: [] }));
    (window.wirebench as unknown as { ssh: Record<string, unknown> }).ssh['saveHosts'] = saveHosts;
    useHostsStore.setState({ file: withHosts });
    render(<ForwardingPanel />);
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }));
    const dialog = screen.getByTestId('new-rule-dialog');
    fireEvent.change(within(dialog).getByLabelText('Host'), { target: { value: 'bastion' } });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Name').value).toBe('forward');
    fireEvent.change(within(dialog).getByLabelText('Port'), { target: { value: '6000' } });
    // The suggested name follows the port, then the target (S14).
    expect(within(dialog).getByLabelText<HTMLInputElement>('Name').value).toBe('local-6000');
    fireEvent.change(within(dialog).getByLabelText('Target (as the host sees it)'), {
      target: { value: 'localhost:6000' },
    });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Name').value).toBe('localhost-6000');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => {
      expect(saveHosts).toHaveBeenCalledOnce();
    });
    const saved = (saveHosts.mock.calls[0]![0] as { file: HostsFileWire }).file;
    expect(saved.hosts.find((h) => h.id === 'bastion')?.forwards).toEqual([
      { id: 'localhost-6000', type: 'local', port: 6000, target: 'localhost:6000' },
    ]);
    expect(saved.hosts.find((h) => h.id === 'db-1')?.forwards).toBeUndefined();
    await waitFor(() => {
      expect(screen.queryByTestId('new-rule-dialog')).toBeNull();
    });
  });

  it('New rule… refuses an id the picked host already has', () => {
    render(<ForwardingPanel />);
    fireEvent.click(screen.getByRole('button', { name: /New rule/ }));
    const dialog = screen.getByTestId('new-rule-dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'pg' } });
    fireEvent.change(within(dialog).getByLabelText('Port'), { target: { value: '6000' } });
    fireEvent.change(within(dialog).getByLabelText('Target (as the host sees it)'), {
      target: { value: 'localhost:6000' },
    });
    expect(within(dialog).getByText('This host already has a rule pg')).toBeDefined();
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Add rule' }).disabled).toBe(true);
  });

  it('keeps a forward whose rule was removed while it ran, with Stop only', async () => {
    act(() => {
      useForwardsStore.getState().apply({ ...running('db-1', 'gone', 9000), removed: true });
    });
    render(<ForwardingPanel />);
    const gone = rowOf('db-1/gone');
    expect(gone.textContent).toContain('removed from hosts.yaml');
    expect(
      within(gone)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Stop']);
    fireEvent.click(within(gone).getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(forward.stop).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'gone' });
    });
    await waitFor(() => {
      expect(screen.queryAllByTestId('forward-row').some((row) => row.dataset['forward'] === 'db-1/gone')).toBe(false);
    });
  });

  it('Start starts the rule; a refusal shows under the row', async () => {
    forward.start.mockResolvedValueOnce(refused('ssh-forward-port-in-use', 'Port 5432 is held by db-2 · pg'));
    render(<ForwardingPanel />);
    fireEvent.click(within(rowOf('db-1/pg')).getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(within(rowOf('db-1/pg')).getByRole('alert').textContent).toBe('Port 5432 is held by db-2 · pg');
    });
    expect(forward.start).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg' });
  });

  it('the host details section shows the same rows for that host only', () => {
    render(<HostForwards hostId="bastion" />);
    expect(screen.getAllByTestId('forward-row').map((row) => row.dataset['forward'])).toEqual(['bastion/socks']);
  });
});

describe('startForward prompts', () => {
  it('a network bind not yet confirmed asks, and Start retries with confirmBind', async () => {
    forward.start.mockResolvedValueOnce(
      refused('ssh-forward-bind-unconfirmed', 'admin listens on 0.0.0.0', { address: '0.0.0.0' }),
    );
    render(<ForwardPrompts />);
    await act(async () => {
      await startForward('db-1', 'admin');
    });
    const dialog = screen.getByTestId('forward-bind-dialog');
    expect(dialog.textContent).toContain('db-1 · admin will be reachable from other machines at 0.0.0.0:8080');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(forward.start).toHaveBeenLastCalledWith({ hostId: 'db-1', ruleId: 'admin', confirmBind: true });
    });
  });

  it('Cancel on the network prompt starts nothing', async () => {
    forward.start.mockResolvedValueOnce(refused('ssh-forward-bind-unconfirmed', 'x', { address: '0.0.0.0' }));
    render(<ForwardPrompts />);
    await act(async () => {
      await startForward('db-1', 'admin');
    });
    fireEvent.click(within(screen.getByTestId('forward-bind-dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByTestId('forward-bind-dialog')).toBeNull();
    });
    expect(forward.start).toHaveBeenCalledTimes(1);
  });

  it('a host key not yet trusted opens the trust dialog and starts again after trust', async () => {
    forward.start.mockResolvedValueOnce(
      refused('ssh-host-key-new', 'unknown key', {
        host: 'db-1.example:22',
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc',
      }),
    );
    render(<TrustDialog />);
    await act(async () => {
      await startForward('db-1', 'pg');
    });
    const dialog = screen.getByTestId('trust-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Trust and connect' }));
    await waitFor(() => {
      expect(forward.start).toHaveBeenCalledTimes(2);
    });
    expect(trustHostKey).toHaveBeenCalledWith({
      host: 'db-1.example:22',
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      replace: false,
    });
    expect(forward.start).toHaveBeenLastCalledWith({ hostId: 'db-1', ruleId: 'pg' });
  });

  it('Start on another port… is pre-filled from forward.freePort and starts on that port', async () => {
    render(<ForwardPrompts />);
    await act(async () => {
      await askForPort('db-1', 'pg');
    });
    expect(forward.freePort).toHaveBeenCalledWith({ near: 5432 });
    const dialog = screen.getByTestId('forward-port-dialog');
    expect(within(dialog).getByLabelText<HTMLInputElement>('Port').value).toBe('5433');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(forward.start).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg', port: 5433 });
    });
  });
});

describe('the SSH status item', () => {
  it('is absent with nothing running or failed', () => {
    render(<SshStatusItem />);
    expect(screen.queryByTestId('status-bar-forwards')).toBeNull();
  });

  it('shows ⇄ 2 with two running, ⇄ 2 · 1 failed in red with one failed, and opens the view', () => {
    act(() => {
      useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
      useForwardsStore.getState().apply(running('db-1', 'admin', 8080));
    });
    render(<SshStatusItem />);
    const item = screen.getByTestId('status-bar-forwards');
    expect(item.textContent).toBe('⇄ 2');
    expect(item.className).not.toContain('text-status-danger');
    act(() => {
      useForwardsStore.getState().apply(failed('bastion', 'socks', 1080));
    });
    expect(item.className).toContain('text-status-danger');
    expect(item.textContent).toBe('⇄ 2 · 1 failed');
    fireEvent.click(item);
    expect(useHostsStore.getState().homeView).toBe('forwarding');
    expect(useEditorsStore.getState().displayedSet).toBe('ssh');
    expect(useUiStore.getState().sidebar.view).toBe('ssh');
  });

  it('does not count a failed forward whose rule or host has gone', () => {
    act(() => {
      useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
      useForwardsStore.getState().apply({ ...failed('gone', 'x', 9000), removed: true });
    });
    render(<SshStatusItem />);
    expect(screen.getByTestId('status-bar-forwards').textContent).toBe('⇄ 1');
  });

  it('the status bar renders it while the SSH area is on, and nothing when it is off', () => {
    act(() => {
      useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
    });
    render(<StatusBar />);
    expect(screen.getByTestId('status-bar-forwards').textContent).toBe('⇄ 1');
    cleanup();
    useUiStore.setState({ enabledAreas: ['explorer'] } as never);
    render(<StatusBar />);
    expect(screen.queryByTestId('status-bar-forwards')).toBeNull();
  });
});

describe('the forwards store', () => {
  it('a stopped state leaves the store; list replaces it', async () => {
    useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
    useForwardsStore.getState().apply({ ...running('db-1', 'pg', 5432), status: { state: 'stopped' } });
    expect(useForwardsStore.getState().byKey).toEqual({});
    forward.list.mockResolvedValueOnce(ok({ forwards: [running('bastion', 'socks', 1080)] }));
    await useForwardsStore.getState().load();
    expect(Object.keys(useForwardsStore.getState().byKey)).toEqual(['bastion/socks']);
  });
});

describe('isNetworkBind', () => {
  it('agrees with @wirebench/ssh', () => {
    for (const bind of [
      'localhost',
      '::1',
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '::',
      '10.0.0.5',
      '192.168.1.2',
      'fe80::1',
    ]) {
      expect(isNetworkBind(bind), bind).toBe(packageIsNetworkBind(bind));
    }
  });
});
