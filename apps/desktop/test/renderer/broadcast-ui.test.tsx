import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom has no canvas or layout, so the terminal is a stand-in that lets a test type into it.
const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    pasted: string[] = [];
    modes = { bracketedPasteMode: false };
    dataListeners: ((text: string) => void)[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    attachCustomKeyEventHandler(): void {}
    write(): void {}
    paste(text: string): void {
      this.pasted.push(text);
    }
    getSelection(): string {
      return '';
    }
    onSelectionChange() {
      return { dispose: () => undefined };
    }
    onData(listener: (text: string) => void) {
      this.dataListeners.push(listener);
      return { dispose: () => undefined };
    }
    onBinary() {
      return { dispose: () => undefined };
    }
    // What the snippet suggestions read; none are offered here (no snippets).
    buffer = { active: { type: 'normal', cursorX: 0 } };
    onWriteParsed() {
      return { dispose: () => undefined };
    }
    dispose(): void {}
    /** What xterm does on a keystroke. */
    type(text: string): void {
      for (const listener of this.dataListeners) listener(text);
    }
  }
  class FakeSearchAddon {
    onDidChangeResults() {
      return { dispose: () => undefined };
    }
    clearDecorations(): void {}
  }
  return { FakeTerminal, FakeSearchAddon };
});
vi.mock('@xterm/xterm', () => ({ Terminal: xterm.FakeTerminal }));
// The output highlights read real buffer cells; they have their own tests and an e2e.
vi.mock('../../src/renderer/features/ssh/output-highlights.js', () => ({
  attachOutputHighlights: () => ({ refresh: () => undefined, dispose: () => undefined }),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: xterm.FakeSearchAddon }));
// ⌘W's command comes with the editor commands, which load Monaco.
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerEditorCommands } from '../../src/renderer/commands/register-editor-commands.js';
import { registerSshCommands } from '../../src/renderer/commands/register-ssh-commands.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useBroadcastStore } from '../../src/renderer/features/ssh/panes/broadcast.js';
import { savableTreeOf } from '../../src/renderer/features/ssh/panes/open-layout.js';
import { usePanesStore } from '../../src/renderer/features/ssh/panes/pane-actions.js';
import { leaves, type PaneNode } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import { EditorArea } from '../../src/renderer/shell/editor-area.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const connect = vi.fn();
const write = vi.fn();
const writeMany = vi.fn();
const resize = vi.fn();
const close = vi.fn();
const TAB = 'ssh-terminal:t1';
const pane = (paneId: string): PaneNode => ({ kind: 'pane', paneId, hostId: 'a' });
/** p1 | (p2 / p3) */
const THREE: PaneNode = {
  kind: 'split',
  dir: 'row',
  ratio: 0.5,
  a: pane('p1'),
  b: { kind: 'split', dir: 'column', ratio: 0.5, a: pane('p2'), b: pane('p3') },
};

beforeEach(() => {
  xterm.FakeTerminal.instances = [];
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
  for (const fn of [connect, write, writeMany, resize, close]) fn.mockReset();
  let n = 0;
  connect.mockImplementation(() => {
    n += 1;
    return Promise.resolve({ ok: true, value: { sessionId: `s${String(n)}` } });
  });
  write.mockResolvedValue({ ok: true, value: {} });
  writeMany.mockResolvedValue({ ok: true, value: { skipped: [] } });
  close.mockResolvedValue({ ok: true, value: {} });
  installWirebenchApi({ ssh: { connect, write, writeMany, resize, close } });
  useEditorsStore.getState().reset();
  useBroadcastStore.setState({ tabs: {} });
  usePanesStore.setState({ focused: {}, picker: undefined });
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [{ id: 'a', name: 'alpha', address: 'a.example', tags: [], ssh: {} }] },
    panes: {},
    trustPrompt: null,
    connectFailed: {},
  });
  resetCommands();
  registerSshCommands(vi.fn());
  registerEditorCommands();
});

afterEach(() => {
  cleanup();
  useEditorsStore.getState().reset();
});

const tree = (): PaneNode | undefined => useEditorsStore.getState().tabs.find((t) => t.id === TAB)?.panes;
const sessionOf = (paneId: string): string | undefined => useHostsStore.getState().panes[paneId]?.sessionId;
/** The terminal of the n-th pane in reading order (they mount in that order). */
const terminal = (n: number) => xterm.FakeTerminal.instances[n];

async function mount(panes: PaneNode): Promise<void> {
  act(() => {
    useEditorsStore.getState().open({ id: TAB, kind: 'ssh-terminal', title: 'alpha', panes });
  });
  render(
    <TooltipPrimitive.Provider>
      <EditorArea />
    </TooltipPrimitive.Provider>,
  );
  const count = leaves(panes).length;
  await waitFor(() => {
    expect(Object.values(useHostsStore.getState().panes).filter((p) => p.state === 'open')).toHaveLength(count);
  });
}

const banner = () => screen.getByTestId('ssh-broadcast-banner');
const broadcastButton = () => screen.getByRole('button', { name: /^Broadcast/ });

describe('broadcast input', () => {
  it('is disabled with one pane', async () => {
    await mount(pane('p1'));
    expect(broadcastButton()).toHaveProperty('disabled', true);
  });

  it('turns on with every pane ticked: banner, red borders, a red dot on the tab', async () => {
    await mount(THREE);
    expect(screen.queryByText(/Broadcasting to/)).toBeNull();
    fireEvent.click(broadcastButton());
    expect(broadcastButton().getAttribute('aria-pressed')).toBe('true');
    expect(banner().textContent).toContain('Broadcasting to 3 of 3 panes');
    expect(banner().closest('[aria-live]')).not.toBeNull();
    expect(screen.getAllByTestId('ssh-pane').map((el) => el.dataset['broadcast'])).toEqual(['true', 'true', 'true']);
    expect(screen.getByRole('tab', { name: /Broadcasting/ })).toBeDefined();
    expect(screen.getAllByRole('checkbox', { name: /Receive broadcast/ })).toHaveLength(3);
  });

  it('input in a ticked pane reaches every ticked pane; in an unticked pane only itself', async () => {
    await mount(THREE);
    fireEvent.click(broadcastButton());
    const box = screen.getAllByRole('checkbox', { name: /Receive broadcast/ })[2] as HTMLElement;
    fireEvent.click(box);
    expect(banner().textContent).toContain('Broadcasting to 2 of 3 panes');
    expect(screen.getAllByTestId('ssh-pane').map((el) => el.dataset['broadcast'])).toEqual(['true', 'true', undefined]);

    act(() => {
      terminal(0)?.type('ls\r');
    });
    expect(writeMany).toHaveBeenCalledWith({ sessionIds: [sessionOf('p1'), sessionOf('p2')], data: 'bHMN' });
    expect(write).not.toHaveBeenCalled();

    act(() => {
      terminal(2)?.type('x');
    });
    expect(write).toHaveBeenCalledWith({ sessionId: sessionOf('p3'), data: 'eA==' });
    expect(writeMany).toHaveBeenCalledTimes(1);
  });

  it('a pane not connected is counted and left out', async () => {
    await mount(THREE);
    fireEvent.click(broadcastButton());
    act(() => {
      useHostsStore.getState().setPane('p2', { hostId: 'a', state: 'connecting' });
    });
    expect(banner().textContent).toContain('Broadcasting to 3 of 3 panes · 1 not connected');
    act(() => {
      terminal(0)?.type('x');
    });
    expect(writeMany).toHaveBeenCalledWith({ sessionIds: [sessionOf('p1'), sessionOf('p3')], data: 'eA==' });
  });

  it('a skipped write says a pane missed input until the next write reaches them all', async () => {
    await mount(THREE);
    fireEvent.click(broadcastButton());
    writeMany.mockResolvedValueOnce({ ok: true, value: { skipped: [sessionOf('p3')] } });
    act(() => {
      terminal(0)?.type('x');
    });
    await waitFor(() => {
      expect(banner().textContent).toContain('1 pane missed input');
    });
    act(() => {
      terminal(0)?.type('y');
    });
    await waitFor(() => {
      expect(banner().textContent).not.toContain('missed input');
    });
  });

  it('a paste into a ticked pane always asks, naming the count, even with "don’t ask again" set', async () => {
    usePreferencesStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES_WIRE,
        terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, confirmMultilinePaste: false },
      },
    });
    await mount(THREE);
    fireEvent.click(broadcastButton());
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'uptime' } });
    act(() => {
      screen.getAllByTestId('ssh-terminal')[0]?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText(/3 panes/).length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Paste' }));
    expect(terminal(0)?.pasted).toEqual(['uptime']);
  });

  it('Stop and the command turn it off', async () => {
    await mount(THREE);
    fireEvent.click(broadcastButton());
    fireEvent.click(within(banner()).getByRole('button', { name: 'Stop' }));
    expect(screen.queryByText(/Broadcasting to/)).toBeNull();
    await act(async () => {
      await runCommand('ssh.toggleBroadcast', {} as never);
    });
    expect(banner().textContent).toContain('Broadcasting to 3 of 3 panes');
    await act(async () => {
      await runCommand('ssh.toggleBroadcast', {} as never);
    });
    expect(screen.queryByText(/Broadcasting to/)).toBeNull();
  });

  it('ends when the tab drops to one pane, and is never part of the saved layout', async () => {
    await mount(THREE);
    const before = savableTreeOf(TAB);
    fireEvent.click(broadcastButton());
    expect(savableTreeOf(TAB)).toEqual(before);
    await act(async () => {
      await runCommand('editor.closeTab', {} as never);
    });
    expect(banner().textContent).toContain('Broadcasting to 2 of 2 panes');
    await act(async () => {
      await runCommand('editor.closeTab', {} as never);
    });
    expect(leaves(tree() ?? pane('none'))).toHaveLength(1);
    expect(screen.queryByText(/Broadcasting to/)).toBeNull();
    expect(useBroadcastStore.getState().tabs).toEqual({});
  });
});
