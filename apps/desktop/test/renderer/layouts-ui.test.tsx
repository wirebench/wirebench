import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.fn();
const save = vi.fn();
const rename = vi.fn();
const remove = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ layout: { list, save, rename, delete: remove }, ssh: { connect: vi.fn() } }),
}));
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { LayoutsPanel } from '../../src/renderer/features/ssh/panes/layouts-view.js';
import { useLayoutsStore } from '../../src/renderer/features/ssh/panes/layouts-store.js';
import { MissingHostPane } from '../../src/renderer/features/ssh/panes/missing-host-pane.js';
import { openLayout, toLayoutNode } from '../../src/renderer/features/ssh/panes/open-layout.js';
import type { PaneNode } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import { leaves } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import { SaveLayoutDialog } from '../../src/renderer/features/ssh/panes/save-layout-dialog.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { resetCommands } from '../../src/renderer/lib/commands.js';
import type { PaletteMode } from '../../src/renderer/shell/command-palette.js';
import { CommandPalette } from '../../src/renderer/shell/command-palette.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import type { LayoutWire } from '../../src/shared/layout-wire.js';

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

const host = (id: string, name = id) =>
  ({
    id,
    name,
    address: `${id}.example`,
    tags: [],
    path: [],
    protected: { value: false, from: 'default' },
    ssh: {},
    forwards: [],
  }) as never;

const PROD: LayoutWire = {
  id: 'L1',
  name: 'Prod databases',
  root: {
    kind: 'split',
    dir: 'row',
    ratio: 0.3,
    a: { kind: 'pane', host: 'db-1' },
    b: { kind: 'pane', host: 'db-2' },
  },
};

/** A split terminal tab on db-1 | db-2 at 0.3, not from a layout. */
function openSplitTab(layoutId?: string): string {
  const panes: PaneNode = {
    kind: 'split',
    dir: 'row',
    ratio: 0.3,
    a: { kind: 'pane', paneId: 'p1', hostId: 'db-1' },
    b: { kind: 'pane', paneId: 'p2', hostId: 'db-2' },
  };
  useEditorsStore.getState().open({
    id: 'ssh-terminal:t1',
    kind: 'ssh-terminal',
    title: 'db-1',
    panes,
    ...(layoutId === undefined ? {} : { layoutId }),
  });
  return 'ssh-terminal:t1';
}

const listed = (layouts: LayoutWire[]) => ({ ok: true, value: { layouts } });

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(listed([PROD]));
  useEditorsStore.getState().reset();
  useLayoutsStore.setState({ layouts: [], loaded: false, savingTabId: undefined });
  useHostsStore.setState({
    resolved: [host('db-1', 'Database 1'), host('db-2', 'Database 2')],
    loaded: true,
    panes: {},
    file: { version: 1, groups: [], hosts: [] },
  });
  useUiStore.setState({ enabledAreas: ['explorer', 'ssh'] } as never);
});
afterEach(() => {
  cleanup();
  resetCommands();
});

describe('the Layouts view', () => {
  it('lists each layout’s name, hosts and pane count', async () => {
    render(<LayoutsPanel />);
    const row = await screen.findByTestId('layout-row');
    expect(row.textContent).toContain('Prod databases');
    expect(row.textContent).toContain('Database 1, Database 2 · 2 panes');
  });

  it('shows the empty state with none', async () => {
    list.mockResolvedValue(listed([]));
    render(<LayoutsPanel />);
    const empty = await screen.findByTestId('layouts-empty');
    expect(empty.textContent).toContain('choose Save layout…');
    fireEvent.click(within(empty).getByRole('button', { name: /Open a host/ }));
    expect(useHostsStore.getState().homeView).toBe('hosts');
  });

  it('the search narrows by name or host and offers Clear search when nothing is left', async () => {
    render(<LayoutsPanel />);
    await screen.findByTestId('layout-row');
    fireEvent.change(screen.getByLabelText('Filter layouts'), { target: { value: 'database 2' } });
    expect(screen.getByTestId('layout-row')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Filter layouts'), { target: { value: 'staging' } });
    expect(screen.queryByTestId('layout-row')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('layout-row')).toBeDefined();
  });

  it('Open opens one tab titled by the layout with every pane', async () => {
    render(<LayoutsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    const tabs = useEditorsStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ title: 'Prod databases', layoutId: 'L1' });
    expect(leaves(tabs[0]!.panes!).map((leaf) => leaf.hostId)).toEqual(['db-1', 'db-2']);
  });

  it('Rename asks for the new name and shows a refusal', async () => {
    rename.mockResolvedValueOnce({
      ok: false,
      error: { code: 'ssh-layout-name-taken', message: 'A layout named "Stage" already exists' },
    });
    render(<LayoutsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Layout name');
    expect((input as HTMLInputElement).value).toBe('Prod databases');
    fireEvent.change(input, { target: { value: 'Stage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already exists');
    rename.mockResolvedValueOnce({ ok: true, value: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(screen.queryByTestId('layout-name-dialog')).toBeNull();
    });
    expect(rename).toHaveBeenLastCalledWith({ id: 'L1', name: 'Stage' });
  });

  it('Delete asks first', async () => {
    remove.mockResolvedValue({ ok: true, value: {} });
    render(<LayoutsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this layout?')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ id: 'L1' });
    });
  });
});

describe('Save layout…', () => {
  it('on a new tab asks for a name and saves the tree with its ratios', async () => {
    const tabId = openSplitTab();
    save.mockResolvedValue({ ok: true, value: { layout: { ...PROD, id: 'L9', name: 'Mine' } } });
    render(<SaveLayoutDialog tabId={tabId} open onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Layout name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ name: 'Mine', root: PROD.root });
    });
    await waitFor(() => {
      expect(useEditorsStore.getState().tabs[0]?.layoutId).toBe('L9');
    });
  });

  it('shows a name already taken', async () => {
    const tabId = openSplitTab();
    save.mockResolvedValue({
      ok: false,
      error: { code: 'ssh-layout-name-taken', message: 'A layout named "Mine" already exists' },
    });
    render(<SaveLayoutDialog tabId={tabId} open onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Layout name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already exists');
  });

  it('on a tab opened from a layout offers Update and Save as new…', async () => {
    useLayoutsStore.setState({ layouts: [PROD], loaded: true });
    const tabId = openSplitTab('L1');
    save.mockResolvedValue({ ok: true, value: { layout: PROD } });
    const closed = vi.fn();
    render(<SaveLayoutDialog tabId={tabId} open onOpenChange={closed} />);
    expect(screen.getByRole('button', { name: 'Save as new…' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Update “Prod databases”' }));
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({ id: 'L1', name: 'Prod databases', root: PROD.root });
    });
    await waitFor(() => {
      expect(closed).toHaveBeenCalledWith(false);
    });
  });

  it('Save as new… asks for a name instead', () => {
    useLayoutsStore.setState({ layouts: [PROD], loaded: true });
    const tabId = openSplitTab('L1');
    render(<SaveLayoutDialog tabId={tabId} open onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save as new…' }));
    expect(screen.getByLabelText('Layout name')).toBeDefined();
  });
});

describe('a pane whose host is gone', () => {
  it('says so and Remove pane closes only that pane', () => {
    openLayout({ ...PROD, root: { ...PROD.root, b: { kind: 'pane', host: 'db-3' } } as LayoutWire['root'] });
    const tab = useEditorsStore.getState().tabs[0]!;
    const missing = leaves(tab.panes!)[1]!;
    render(<MissingHostPane tabId={tab.id} pane={missing} />);
    expect(screen.getByTestId('ssh-pane-missing').textContent).toBe('Host db-3 is no longer in hosts.yaml·Remove pane');
    fireEvent.click(screen.getByRole('button', { name: 'Remove pane' }));
    const after = useEditorsStore.getState().tabs[0]!;
    expect(toLayoutNode(after.panes!)).toEqual({ kind: 'pane', host: 'db-1' });
  });
});

describe('layouts in the palette', () => {
  function Shell() {
    const [open, setOpen] = useState(true);
    const [mode, setMode] = useState<PaletteMode>('commands');
    resetCommands();
    registerSshCommands((next = 'commands') => {
      setMode(next);
      setOpen(true);
    });
    return <CommandPalette open={open} onOpenChange={setOpen} context={context} mode={mode} />;
  }

  it('⌘K Layouts: Open Layout… lists the layouts and opens the one picked', async () => {
    render(<Shell />);
    fireEvent.click(screen.getByText('Layouts: Open Layout…'));
    expect(screen.getByPlaceholderText('Open layout')).toBeDefined();
    fireEvent.click(await screen.findByText('Prod databases'));
    expect(useEditorsStore.getState().tabs).toMatchObject([{ title: 'Prod databases', layoutId: 'L1' }]);
  });

  it('⌘P lists them under a Layouts heading', async () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="quick-open" />);
    expect(await screen.findByText('Prod databases')).toBeDefined();
    expect(screen.getByText('Layouts')).toBeDefined();
  });

  it('⌘K Layouts: Save Layout… opens the dialog for the terminal tab in front', () => {
    openSplitTab();
    render(<Shell />);
    act(() => {
      fireEvent.click(screen.getByText('Layouts: Save Layout…'));
    });
    expect(useLayoutsStore.getState().savingTabId).toBe('ssh-terminal:t1');
  });
});
