import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostsFileWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const setHostOs = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
const secretNames = vi.fn(() => Promise.resolve({ ok: true, value: { names: [] } }));
const keys = vi.fn(() => Promise.resolve({ ok: true, value: { keys: [] } }));
const start = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
const stop = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
const stopAll = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts, setHostOs, secretNames, keys }, forward: { start, stop, stopAll } }),
}));
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { useForwardsStore } from '../../src/renderer/features/ssh/forwarding/forwards-store.js';
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { getCommand, resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import type { PaletteMode } from '../../src/renderer/shell/command-palette.js';
import { CommandPalette } from '../../src/renderer/shell/command-palette.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { COMMAND_CATALOG } from '../../src/shared/command-catalog.js';

const GRAFANA = { id: 'grafana', type: 'local', port: 3000, target: 'localhost:3000' } as const;

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'prod',
      name: 'Production',
      tags: [],
      ssh: {},
      forwards: [GRAFANA],
      groups: [],
      hosts: [
        {
          id: 'db-1',
          name: 'db-1',
          address: '10.0.1.7',
          tags: [],
          ssh: {},
          forwards: [{ id: 'pg', type: 'local', port: 5432, target: 'localhost:5432' }],
        },
      ],
    },
  ],
  hosts: [],
};

const resolvedRule = (id: string, port: number) => ({
  rule: { id, type: 'local' as const, port, bind: '127.0.0.1', target: { host: 'localhost', port }, autoStart: false },
  from: 'host' as const,
  enabled: true,
});
const RESOLVED: ResolvedHostWire[] = [
  {
    id: 'db-1',
    name: 'db-1',
    address: '10.0.1.7',
    tags: [],
    path: ['prod'],
    protected: { value: false, from: 'default' },
    ssh: {
      user: { value: undefined, from: 'default' },
      port: { value: 22, from: 'default' },
      auth: { value: undefined, from: 'default' },
      jump: { value: undefined, from: 'default' },
      keepAlive: { value: 15, from: 'default' },
      connectTimeout: { value: 20, from: 'default' },
      forwardAgent: { value: false, from: 'default' },
      proxy: { value: undefined, from: 'default' },
    },
    forwards: [
      { ...resolvedRule('grafana', 3000), from: { group: 'prod' } },
      resolvedRule('pg', 5432),
      { ...resolvedRule('old', 9000), enabled: false, offBy: 'host' },
    ],
    env: [],
  },
];

/** The file of the last `ssh.saveHosts` call. */
const saved = (): HostsFileWire => (saveHosts.mock.lastCall?.[0] as { file: HostsFileWire }).file;
const savedHost = () => saved().groups[0]!.hosts[0]!;

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

beforeEach(() => {
  vi.clearAllMocks();
  saveHosts.mockImplementation(({ file }: { file: HostsFileWire }) =>
    Promise.resolve({ ok: true, value: { file, resolved: RESOLVED, problems: [] } }),
  );
  useHostsStore.setState({
    file: FILE,
    resolved: RESOLVED,
    problems: [],
    loaded: true,
    dialog: { mode: 'edit-host', id: 'db-1' },
    osByHost: {},
    homeView: 'hosts',
  });
  useForwardsStore.getState().reset();
  useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
});
afterEach(() => {
  cleanup();
  resetCommands();
});

const editDb1 = () => render(<HostForm file={FILE} dialog={{ mode: 'edit-host', id: 'db-1' }} embedded />);
const save = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('the rule editor in the host and group forms', () => {
  it('a host under prod shows grafana greyed from Production with Override and Off', () => {
    editDb1();
    const row = screen.getByTestId('inherited-forward');
    expect(row.textContent).toContain('grafana');
    expect(row.textContent).toContain('from Production');
    expect(within(row).getByRole('switch', { name: 'Override grafana' }).getAttribute('aria-checked')).toBe('false');
    expect(within(row).getByRole('switch', { name: 'Off grafana' }).getAttribute('aria-checked')).toBe('false');
  });

  it('Off writes { id: grafana, enabled: false } on the host', async () => {
    editDb1();
    await userEvent.click(screen.getByRole('switch', { name: 'Off grafana' }));
    expect(screen.getByTestId('inherited-forward').textContent).toContain('off here');
    await save();
    expect(savedHost().forwards).toEqual([
      { id: 'pg', type: 'local', port: 5432, target: 'localhost:5432' },
      { id: 'grafana', enabled: false },
    ]);
  });

  it('Override copies the rule to the host, editable', async () => {
    editDb1();
    await userEvent.click(screen.getByRole('switch', { name: 'Override grafana' }));
    const form = screen.getByRole('group', { name: 'Rule grafana' });
    expect(form.textContent).toContain('overrides Production');
    const port = within(form).getByLabelText('Port');
    await userEvent.clear(port);
    await userEvent.type(port, '3001');
    await save();
    expect(savedHost().forwards).toEqual([
      { id: 'pg', type: 'local', port: 5432, target: 'localhost:5432' },
      { ...GRAFANA, port: 3001 },
    ]);
  });

  it('a new dynamic rule hides Target; a network bind shows the warning; saving sends the whole file', async () => {
    editDb1();
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    const form = screen.getByRole('group', { name: 'Rule forward' });
    expect(within(form).getByLabelText(/Target/)).toBeDefined();
    await userEvent.click(within(form).getByRole('radio', { name: 'Dynamic (SOCKS)' }));
    expect(within(form).queryByLabelText(/Target/)).toBeNull();
    await userEvent.type(within(form).getByLabelText('Port'), '1080');
    expect(within(form).queryByRole('note')).toBeNull();
    await userEvent.type(within(form).getByLabelText('Bind'), '0.0.0.0');
    expect(within(form).getByRole('note').textContent).toContain('Reachable from other machines at 0.0.0.0:1080');
    await userEvent.click(within(form).getByRole('checkbox', { name: "Start with the host's terminals" }));
    await save();
    expect(saved().groups[0]!.forwards).toEqual([GRAFANA]);
    expect(savedHost().forwards).toEqual([
      { id: 'pg', type: 'local', port: 5432, target: 'localhost:5432' },
      { id: 'forward', type: 'dynamic', port: 1080, bind: '0.0.0.0', autoStart: true },
    ]);
  });

  it('Save waits for a valid rule: a local rule needs a target', async () => {
    editDb1();
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    const form = screen.getByRole('group', { name: 'Rule forward' });
    await userEvent.type(within(form).getByLabelText('Port'), '8080');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    await userEvent.type(within(form).getByLabelText(/Target/), 'localhost:80');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(false);
  });

  it('a duplicate id on one level shows the refusal from the answer', async () => {
    saveHosts.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'ssh-forward-duplicate-id',
        message: 'db-1 has two forwarding rules with the id "pg"',
        details: { path: 'groups[0].hosts[0].forwards[1]' },
      },
    });
    editDb1();
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    const form = screen.getByRole('group', { name: 'Rule forward' });
    const id = within(form).getByLabelText('Name');
    await userEvent.clear(id);
    await userEvent.type(id, 'pg');
    await userEvent.type(within(form).getByLabelText('Port'), '6432');
    await userEvent.type(within(form).getByLabelText(/Target/), 'localhost:6432');
    await save();
    expect(screen.getByRole('alert').textContent).toBe('db-1 has two forwarding rules with the id "pg"');
  });

  it('a group form edits the group’s own rules and keeps them on save', async () => {
    useHostsStore.setState({ dialog: { mode: 'edit-group', id: 'prod' } });
    render(<HostForm file={FILE} dialog={{ mode: 'edit-group', id: 'prod' }} embedded />);
    const form = screen.getByRole('group', { name: 'Rule grafana' });
    await userEvent.click(within(form).getByRole('button', { name: 'Remove' }));
    await save();
    expect(saved().groups[0]!.forwards).toBeUndefined();
    expect(savedHost().forwards).toHaveLength(1);
  });
});

describe('forwarding commands', () => {
  it('are in the catalog', () => {
    for (const id of ['view.showForwarding', 'ssh.startForward', 'ssh.stopForward', 'ssh.stopAllForwards'] as const) {
      expect(COMMAND_CATALOG[id].id).toBe(id);
    }
    expect(COMMAND_CATALOG['ssh.startForward'].label).toBe('Forwarding: Start Port Forward…');
  });

  it('Start port forward… lists every on rule as host · rule and starts the picked one', async () => {
    let mode: PaletteMode | undefined;
    registerSshCommands((m) => {
      mode = m;
    });
    await runCommand('ssh.startForward', context);
    expect(mode).toBe('start-forward');
    const onChange = vi.fn();
    render(<CommandPalette open onOpenChange={onChange} context={context} mode="start-forward" />);
    const items = screen.getAllByTestId('palette-forward').map((item) => item.textContent);
    expect(items.some((text) => text?.includes('db-1 · grafana'))).toBe(true);
    expect(items.some((text) => text?.includes('db-1 · pg'))).toBe(true);
    expect(items.some((text) => text?.includes('old'))).toBe(false);
    await userEvent.click(screen.getAllByTestId('palette-forward').find((i) => i.textContent?.includes('pg'))!);
    expect(start).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg' });
  });

  it('Stop port forward… lists what runs; Stop all stops every one; Show opens the view', async () => {
    act(() => {
      useForwardsStore.getState().apply({
        hostId: 'db-1',
        ruleId: 'pg',
        origin: 'manual',
        port: 5432,
        status: { state: 'running', listening: { address: '127.0.0.1', port: 5432 }, connections: 0 },
      });
    });
    registerSshCommands(() => undefined);
    render(<CommandPalette open onOpenChange={vi.fn()} context={context} mode="stop-forward" />);
    const items = screen.getAllByTestId('palette-forward');
    expect(items.map((item) => item.textContent?.includes('db-1 · pg'))).toEqual([true]);
    await userEvent.click(items[0]!);
    expect(stop).toHaveBeenCalledWith({ hostId: 'db-1', ruleId: 'pg' });
    await runCommand('ssh.stopAllForwards', context);
    expect(stopAll).toHaveBeenCalledWith({});
    await runCommand('view.showForwarding', context);
    expect(useHostsStore.getState().homeView).toBe('forwarding');
    expect(getCommand('ssh.stopForward')).toBeDefined();
  });
});
