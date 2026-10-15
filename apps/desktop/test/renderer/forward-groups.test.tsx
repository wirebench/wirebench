import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGroup,
  deleteGroup,
  freeGroupId,
  groupOfRule,
  groupStatus,
  groupStatusText,
  moveRule,
  renameGroup,
  startGroup,
  stopGroup,
} from '../../src/renderer/features/ssh/forwarding/forward-groups.js';
import { ForwardDetails, useForwardDetailsShown } from '../../src/renderer/features/ssh/forwarding/forward-details.js';
import { ForwardingPanel } from '../../src/renderer/features/ssh/forwarding/forwarding-view.js';
import { useForwardsStore } from '../../src/renderer/features/ssh/forwarding/forwards-store.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import type { PaletteMode } from '../../src/renderer/shell/command-palette.js';
import { CommandPalette } from '../../src/renderer/shell/command-palette.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { COMMAND_CATALOG } from '../../src/shared/command-catalog.js';
import type { ForwardStateWire } from '../../src/shared/forward-wire.js';
import type { HostsFileWire, ResolvedForwardWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';

/** Forwarding groups (#583): the file edits, the group status, Start/Stop group and the view's sections. */

const forward = { list: vi.fn(), start: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), freePort: vi.fn() };
const saveHosts = vi.fn();

const ok = <T,>(value: T) => ({ ok: true as const, value });
const refused = (code: string, message: string) => ({ ok: false as const, error: { code, message } });

const rule = (
  id: string,
  port: number,
  rest: Partial<Omit<ResolvedForwardWire, 'rule'>> = {},
): ResolvedForwardWire => ({
  rule: { id, type: 'local', port, bind: '127.0.0.1', target: { host: 'localhost', port }, autoStart: false },
  from: 'host',
  enabled: true,
  ...rest,
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

const DB1 = host('db-1', [rule('pg', 5432), rule('grafana', 3000, { enabled: false, offBy: 'host' })]);
const CACHE = host('cache', [rule('redis', 6379), rule('admin', 8080)]);

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
        { host: 'db-1', rule: 'grafana' },
      ],
    },
    { id: 'old', name: 'Old', rules: [{ host: 'gone', rule: 'x' }] },
  ],
};

const running = (hostId: string, ruleId: string, port: number): ForwardStateWire => ({
  hostId,
  ruleId,
  origin: 'manual',
  port,
  status: { state: 'running', listening: { address: '127.0.0.1', port }, connections: 0 },
});

const rowOf = (key: string): HTMLElement => {
  const row = screen.getAllByTestId('forward-row').find((el) => el.dataset['forward'] === key);
  if (row === undefined) throw new Error(`no row ${key}`);
  return row;
};
const section = (id: string): HTMLElement => {
  const el = screen.getAllByTestId('forward-group').find((s) => s.dataset['group'] === id);
  if (el === undefined) throw new Error(`no section ${id}`);
  return el;
};
const saved = (): HostsFileWire => (saveHosts.mock.calls.at(-1)![0] as { file: HostsFileWire }).file;

beforeEach(() => {
  vi.clearAllMocks();
  forward.list.mockResolvedValue(ok({ forwards: [] }));
  forward.start.mockResolvedValue(ok({}));
  forward.stop.mockResolvedValue(ok({}));
  saveHosts.mockImplementation(({ file }: { file: HostsFileWire }) =>
    Promise.resolve(ok({ file, resolved: [DB1, CACHE], problems: [] })),
  );
  Object.defineProperty(window, 'wirebench', {
    configurable: true,
    value: { forward, ssh: { saveHosts }, on: () => () => undefined },
  });
  useForwardsStore.getState().reset();
  useHostsStore.setState({ resolved: [DB1, CACHE], file: FILE, loaded: true, problems: [] });
  useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
});
afterEach(() => {
  cleanup();
  resetCommands();
});

describe('forwarding group edits', () => {
  it('names a new group from its name, numbered when the id is taken', () => {
    expect(freeGroupId(FILE, 'Staging DB')).toBe('staging-db');
    expect(freeGroupId(FILE, 'Dev')).toBe('dev-2');
    expect(freeGroupId(FILE, '!!!')).toBe('group');
  });

  it('a rule moves into one group at a time, and out of all', () => {
    const { file, id } = createGroup(FILE, 'Cache', { hostId: 'cache', ruleId: 'redis' });
    expect(id).toBe('cache');
    expect(groupOfRule(file, 'cache', 'redis')?.id).toBe('cache');
    expect(file.forwardGroups?.[0]?.rules).not.toContainEqual({ host: 'cache', rule: 'redis' });
    const back = moveRule(file, 'cache', 'redis', 'dev');
    expect(groupOfRule(back, 'cache', 'redis')?.id).toBe('dev');
    expect(back.forwardGroups?.find((g) => g.id === 'cache')?.rules).toEqual([]);
    expect(groupOfRule(moveRule(back, 'cache', 'redis', undefined), 'cache', 'redis')).toBeUndefined();
  });

  it('renames and deletes a group; deleting keeps the rules', () => {
    expect(renameGroup(FILE, 'dev', 'Development').forwardGroups?.[0]?.name).toBe('Development');
    const without = deleteGroup(FILE, 'dev');
    expect(without.forwardGroups?.map((g) => g.id)).toEqual(['old']);
    expect(without.hosts).toBe(FILE.hosts);
  });

  it('counts the rules that can run, those running and those failed', () => {
    const dev = FILE.forwardGroups![0]!;
    const byKey = { 'db-1/pg': running('db-1', 'pg', 5432) };
    const status = groupStatus(dev, [DB1, CACHE], byKey, { 'cache/redis': { code: 'x', message: 'refused' } });
    // grafana is switched off on db-1: it does not count.
    expect(status).toEqual({ total: 2, running: 1, failed: 1 });
    expect(groupStatusText(status)).toBe('1 of 2 running · 1 failed');
    expect(groupStatusText({ total: 2, running: 2, failed: 0 })).toBe('2 of 2 running');
  });
});

describe('Start group and Stop group', () => {
  it('starts every rule that can run at once, across hosts; one refusal does not stop the others', async () => {
    forward.start.mockImplementation(({ ruleId }: { ruleId: string }) =>
      Promise.resolve(ruleId === 'redis' ? refused('ssh-auth-failed', 'cache refused the key') : ok({})),
    );
    await act(async () => {
      await startGroup('dev');
    });
    expect(forward.start.mock.calls.map((c) => (c[0] as { ruleId: string }).ruleId).sort()).toEqual(['pg', 'redis']);
    expect(useForwardsStore.getState().startErrors['cache/redis']?.message).toBe('cache refused the key');
    expect(useForwardsStore.getState().startErrors['db-1/pg']).toBeUndefined();
  });

  it('skips a rule already running', async () => {
    useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
    await act(async () => {
      await startGroup('dev');
    });
    expect(forward.start).toHaveBeenCalledOnce();
    expect(forward.start).toHaveBeenCalledWith({ hostId: 'cache', ruleId: 'redis' });
  });

  it('stops the rules of the group this window holds, and only those', async () => {
    useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
    useForwardsStore.getState().apply(running('cache', 'admin', 8080));
    useForwardsStore.getState().setStartError('cache/redis', { code: 'x', message: 'refused' });
    await act(async () => {
      await stopGroup('dev');
    });
    expect(forward.stop).toHaveBeenCalledOnce();
    expect(forward.stop).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg' });
    expect(useForwardsStore.getState().startErrors).toEqual({});
    expect(Object.keys(useForwardsStore.getState().byKey)).toEqual(['cache/admin']);
  });
});

describe('the Port forwarding view with groups', () => {
  it('shows each group as a section in its order, with its status, then Ungrouped', () => {
    useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
    render(<ForwardingPanel />);
    expect(screen.getAllByTestId('forward-group').map((s) => s.dataset['group'])).toEqual(['dev', 'old', '']);
    expect(
      within(section('dev'))
        .getAllByTestId('forward-row')
        .map((r) => r.dataset['forward']),
    ).toEqual(['db-1/pg', 'cache/redis', 'db-1/grafana']);
    expect(within(section('dev')).getByTestId('forward-group-status').textContent).toBe('1 of 2 running');
    expect(
      within(section(''))
        .getAllByTestId('forward-row')
        .map((r) => r.dataset['forward']),
    ).toEqual(['cache/admin']);
    expect(within(section('')).getByRole('heading').textContent).toBe('Ungrouped');
  });

  it('Start group runs the group, and its status counts a failure: 1 of 2 running · 1 failed', async () => {
    forward.start.mockImplementation(({ ruleId }: { ruleId: string }) =>
      Promise.resolve(ruleId === 'redis' ? refused('ssh-auth-failed', 'cache refused the key') : ok({})),
    );
    render(<ForwardingPanel />);
    await userEvent.click(within(section('dev')).getByRole('button', { name: 'Start group' }));
    act(() => {
      useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
    });
    await waitFor(() => {
      expect(within(section('dev')).getByTestId('forward-group-status').textContent).toBe('1 of 2 running · 1 failed');
    });
    expect(within(rowOf('cache/redis')).getByRole('alert').textContent).toBe('cache refused the key');
    // A rule of the group still starts and stops on its own.
    expect(within(rowOf('cache/redis')).getByRole('button', { name: 'Start' })).toBeTruthy();
    await userEvent.click(within(rowOf('db-1/pg')).getByRole('button', { name: 'Stop' }));
    expect(forward.stop).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg' });
  });

  it('Stop group shows while a rule of the group runs', async () => {
    useForwardsStore.getState().apply(running('db-1', 'pg', 5432));
    useForwardsStore.getState().apply(running('cache', 'redis', 6379));
    render(<ForwardingPanel />);
    expect(within(section('dev')).queryByRole('button', { name: 'Start group' })).toBeNull();
    await userEvent.click(within(section('dev')).getByRole('button', { name: 'Stop group' }));
    expect(forward.stop).toHaveBeenCalledTimes(2);
  });

  it('a member whose rule has gone offers Remove from group', async () => {
    render(<ForwardingPanel />);
    expect(within(rowOf('gone/x')).getByText('removed from hosts.yaml')).toBeTruthy();
    await userEvent.click(within(rowOf('gone/x')).getByRole('button', { name: 'Remove from group' }));
    await waitFor(() => {
      expect(saved().forwardGroups?.find((g) => g.id === 'old')?.rules).toEqual([]);
    });
  });

  it('New group… creates an empty group, which says how to fill it', async () => {
    render(<ForwardingPanel />);
    await userEvent.click(screen.getByRole('button', { name: /New group/ }));
    await userEvent.type(screen.getByLabelText('Group name'), 'Staging');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(saved().forwardGroups?.map((g) => g.id)).toEqual(['dev', 'old', 'staging']);
    });
    expect(within(section('staging')).getByText(/No rules yet/)).toBeTruthy();
  });

  it('Move to group moves a rule; New group… from a row creates a group holding it', async () => {
    render(<ForwardingPanel />);
    await userEvent.click(within(rowOf('cache/admin')).getByRole('button', { name: 'More actions for admin' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to group' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Dev' }));
    await waitFor(() => {
      expect(saved().forwardGroups?.[0]?.rules).toContainEqual({ host: 'cache', rule: 'admin' });
    });

    await userEvent.click(within(rowOf('cache/redis')).getByRole('button', { name: 'More actions for redis' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to group' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New group…' }));
    await userEvent.type(screen.getByLabelText('Group name'), 'Cache');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(saved().forwardGroups?.find((g) => g.id === 'cache')?.rules).toEqual([{ host: 'cache', rule: 'redis' }]);
    });
    expect(saved().forwardGroups?.[0]?.rules).not.toContainEqual({ host: 'cache', rule: 'redis' });
  });

  it('Rename… and Delete group edit hosts.yaml', async () => {
    render(<ForwardingPanel />);
    await userEvent.click(within(section('dev')).getByRole('button', { name: 'More actions for group Dev' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const name = screen.getByLabelText('Group name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Development');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(saved().forwardGroups?.[0]?.name).toBe('Development');
    });

    await userEvent.click(within(section('dev')).getByRole('button', { name: 'More actions for group Development' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete group' }));
    await waitFor(() => {
      expect(saved().forwardGroups?.map((g) => g.id)).toEqual(['old']);
    });
  });

  it('a search hides the groups with nothing matching', async () => {
    render(<ForwardingPanel />);
    await userEvent.type(screen.getByLabelText('Filter forwards'), 'admin');
    expect(screen.getAllByTestId('forward-group').map((s) => s.dataset['group'])).toEqual(['']);
  });
});

const context: CommandContext = {
  platform: 'mac',
  ui: {
    sidebar: DEFAULT_UI_STATE.sidebar,
    console: DEFAULT_UI_STATE.console,
    slideOver: DEFAULT_UI_STATE.slideOver,
    theme: DEFAULT_UI_STATE.theme,
    editorLineNumbers: DEFAULT_UI_STATE.editorLineNumbers,
    editorLayout: DEFAULT_UI_STATE.editorLayout,
  },
  selection: undefined,
};

describe('the forwarding group palette commands', () => {
  it('are in the catalog under Forwarding', () => {
    expect(COMMAND_CATALOG['ssh.startForwardGroup'].label).toBe('Forwarding: Start Forwarding Group…');
    expect(COMMAND_CATALOG['ssh.stopForwardGroup'].label).toBe('Forwarding: Stop Forwarding Group…');
  });

  it('Start forwarding group… lists the groups with a rule to start, with their status, and starts the pick', async () => {
    let mode: PaletteMode | undefined;
    registerSshCommands((m) => {
      mode = m;
    });
    await runCommand('ssh.startForwardGroup', context);
    expect(mode).toBe('start-forward-group');
    render(<CommandPalette open onOpenChange={vi.fn()} context={context} mode="start-forward-group" />);
    // Old has no rule that can run.
    const items = screen.getAllByTestId('palette-forward-group');
    expect(items.map((item) => item.textContent)).toEqual(['Dev0 of 2 running']);
    await userEvent.click(items[0]!);
    await waitFor(() => {
      expect(forward.start).toHaveBeenCalledTimes(2);
    });
  });

  it('Stop forwarding group… lists the groups holding a rule and stops the pick; a named group runs directly', async () => {
    useForwardsStore.getState().apply(running('cache', 'redis', 6379));
    registerSshCommands(() => undefined);
    render(<CommandPalette open onOpenChange={vi.fn()} context={context} mode="stop-forward-group" />);
    const items = screen.getAllByTestId('palette-forward-group');
    expect(items.map((item) => item.textContent)).toEqual(['Dev1 of 2 running']);
    await userEvent.click(items[0]!);
    await waitFor(() => {
      expect(forward.stop).toHaveBeenCalledWith({ hostId: 'cache', ruleId: 'redis' });
    });
    await runCommand('ssh.startForwardGroup', context, 'dev');
    await waitFor(() => {
      expect(forward.start).toHaveBeenCalledTimes(2);
    });
  });
});

/** A DataTransfer as jsdom lacks one: what a drag sets, the drop reads. */
function dataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    get types() {
      return [...data.keys()];
    },
    effectAllowed: 'all',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

describe('dragging rules between groups', () => {
  it('drops a rule on a group to move it there, and on Ungrouped to take it out', async () => {
    render(<ForwardingPanel />);
    const carry = dataTransfer();
    fireEvent.dragStart(rowOf('cache/admin'), { dataTransfer: carry });
    fireEvent.dragOver(section('dev'), { dataTransfer: carry });
    expect(section('dev').dataset['dropOver']).toBe('true');
    fireEvent.drop(section('dev'), { dataTransfer: carry });
    await waitFor(() => {
      expect(saved().forwardGroups?.[0]?.rules).toContainEqual({ host: 'cache', rule: 'admin' });
    });
    expect(section('dev').dataset['dropOver']).toBeUndefined();

    const out = dataTransfer();
    fireEvent.dragStart(rowOf('db-1/pg'), { dataTransfer: out });
    fireEvent.dragOver(section(''), { dataTransfer: out });
    fireEvent.drop(section(''), { dataTransfer: out });
    await waitFor(() => {
      expect(saved().forwardGroups?.[0]?.rules).not.toContainEqual({ host: 'db-1', rule: 'pg' });
    });
  });

  it('shows Ungrouped as a drop target while a rule is dragged, even when every rule is grouped', () => {
    const all = {
      ...FILE,
      forwardGroups: [
        {
          id: 'dev',
          name: 'Dev',
          rules: [
            { host: 'db-1', rule: 'pg' },
            { host: 'db-1', rule: 'grafana' },
            { host: 'cache', rule: 'redis' },
            { host: 'cache', rule: 'admin' },
          ],
        },
      ],
    };
    useHostsStore.setState({ file: all });
    render(<ForwardingPanel />);
    expect(screen.getAllByTestId('forward-group').map((s) => s.dataset['group'])).toEqual(['dev']);
    const carry = dataTransfer();
    fireEvent.dragStart(rowOf('cache/admin'), { dataTransfer: carry });
    expect(within(section('')).getByText('Drop a rule here to take it out of its group.')).toBeTruthy();
    fireEvent.dragEnd(rowOf('cache/admin'));
    expect(screen.getAllByTestId('forward-group').map((s) => s.dataset['group'])).toEqual(['dev']);
  });

  it('dropping a rule on its own group saves nothing; a removed rule and other drags are ignored', () => {
    render(<ForwardingPanel />);
    const carry = dataTransfer();
    fireEvent.dragStart(rowOf('db-1/pg'), { dataTransfer: carry });
    fireEvent.drop(section('dev'), { dataTransfer: carry });
    expect(rowOf('gone/x').getAttribute('draggable')).toBeNull();
    const text = dataTransfer();
    text.setData('text/plain', 'hello');
    fireEvent.dragOver(section('dev'), { dataTransfer: text });
    expect(section('dev').dataset['dropOver']).toBeUndefined();
    fireEvent.drop(section('dev'), { dataTransfer: text });
    expect(saveHosts).not.toHaveBeenCalled();
  });
});

describe('the forward details panel', () => {
  function Shown() {
    return <span data-testid="shown">{String(useForwardDetailsShown())}</span>;
  }

  it('a click on a row picks it and opens its details; its own buttons do not pick', async () => {
    render(<ForwardingPanel />);
    await userEvent.click(within(rowOf('cache/admin')).getByRole('button', { name: 'Start' }));
    expect(useForwardsStore.getState().selectedKey).toBeUndefined();
    fireEvent.click(rowOf('cache/admin'));
    expect(useForwardsStore.getState()).toMatchObject({ selectedKey: 'cache/admin', detailsOpen: true });
    expect(rowOf('cache/admin').dataset['selected']).toBe('true');
    fireEvent.keyDown(rowOf('db-1/pg'), { key: 'Enter' });
    expect(useForwardsStore.getState().selectedKey).toBe('db-1/pg');
  });

  it('shows only on the Port forwarding view in front, with a picked row not put away', () => {
    useEditorsStore.setState({ displayedSet: 'ssh', activeId: undefined } as never);
    useHostsStore.setState({ homeView: 'forwarding' } as never);
    render(<Shown />);
    expect(screen.getByTestId('shown').textContent).toBe('false');
    act(() => {
      useForwardsStore.getState().select('db-1/pg');
    });
    expect(screen.getByTestId('shown').textContent).toBe('true');
    act(() => {
      useForwardsStore.getState().setDetailsOpen(false);
    });
    expect(screen.getByTestId('shown').textContent).toBe('false');
    act(() => {
      useForwardsStore.getState().setDetailsOpen(true);
      useHostsStore.setState({ homeView: 'hosts' } as never);
    });
    expect(screen.getByTestId('shown').textContent).toBe('false');
    act(() => {
      useHostsStore.setState({ homeView: 'forwarding' } as never);
      useForwardsStore.getState().select('nowhere/x');
    });
    expect(screen.getByTestId('shown').textContent).toBe('false');
  });

  it('shows the rule, what runs of it and its group, with Stop while it runs', async () => {
    useForwardsStore.getState().apply({ ...running('db-1', 'pg', 15432), origin: 'auto' });
    useForwardsStore.getState().select('db-1/pg');
    render(<ForwardDetails />);
    const panel = screen.getByTestId('forward-details');
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe('pg');
    expect(screen.getByTestId('forward-details-state').textContent).toBe('running · 0 connections');
    const rule = within(panel).getByRole('region', { name: 'Rule' });
    expect(rule.textContent).toContain('127.0.0.1:15432');
    expect(rule.textContent).toContain('15432 this run; the rule says 5432');
    expect(rule.textContent).toContain('localhost:5432');
    expect(within(panel).getByRole('region', { name: 'Now' }).textContent).toContain("with the host's terminals");
    expect(within(panel).getByRole('combobox', { name: 'Forwarding group' })).toHaveProperty('value', 'dev');
    await userEvent.click(within(panel).getByRole('button', { name: 'Stop' }));
    expect(forward.stop).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg' });
  });

  it('a failed forward shows its error and Retry; the group select moves the rule', async () => {
    useForwardsStore.getState().apply({
      hostId: 'cache',
      ruleId: 'admin',
      origin: 'manual',
      port: 8080,
      status: { state: 'failed', error: { code: 'ssh-forward-bind', message: 'port 8080 is in use' } },
    });
    useForwardsStore.getState().select('cache/admin');
    render(<ForwardDetails />);
    expect(screen.getByRole('alert').textContent).toBe('port 8080 is in use');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Forwarding group' }), { target: { value: 'dev' } });
    await waitFor(() => {
      expect(saved().forwardGroups?.[0]?.rules).toContainEqual({ host: 'cache', rule: 'admin' });
    });
  });
});
