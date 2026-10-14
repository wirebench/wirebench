import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const runSnippet = vi.fn();
const listSnippets = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { runSnippet, listSnippets } }),
}));
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { usePanesStore } from '../../src/renderer/features/ssh/panes/pane-actions.js';
import { useRunDialogStore } from '../../src/renderer/features/ssh/snippets/run.js';
import {
  closeSnippetPicker,
  openSnippetPicker,
  useSnippetPickerStore,
} from '../../src/renderer/features/ssh/snippets/snippet-actions.js';
import { useSnippetsStore } from '../../src/renderer/features/ssh/snippets/snippets-store.js';
import { TerminalPicker } from '../../src/renderer/features/ssh/snippets/terminal-picker.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { SnippetListItemWire } from '../../src/shared/snippets-wire.js';

const item = (over: Partial<SnippetListItemWire> = {}): SnippetListItemWire => ({
  id: 'tail',
  name: 'Tail logs',
  tags: ['logs'],
  firstLine: 'tail -f /var/log/syslog',
  literalStart: 'tail -f /var/log/syslog',
  variables: [],
  secrets: [],
  enter: true,
  confirm: false,
  lineCount: 1,
  revision: 'rev-1',
  ...over,
});

const TAIL = item();
const DISK = item({ id: 'disk', name: 'Disk usage', tags: [], packageName: 'Ops', firstLine: 'df -h' });
const TAB = 'ssh-terminal:t1';

beforeEach(() => {
  localStorage.clear();
  runSnippet.mockReset().mockResolvedValue({ ok: true, value: {} });
  listSnippets.mockReset();
  useWorkspaceStore.setState({ workspace: { id: 'w1' } as never });
  useEditorsStore.setState({
    tabs: [
      { id: TAB, kind: 'ssh-terminal', title: 'web', panes: { kind: 'pane', paneId: 'p1', hostId: 'web' } },
    ] as never,
    activeId: TAB,
  });
  useHostsStore.setState({ panes: { p1: { hostId: 'web', sessionId: 's-web', state: 'open' } } });
  useSnippetsStore.setState({ snippets: [TAIL, DISK], loaded: true });
  useRunDialogStore.setState({ request: null });
});
afterEach(() => {
  cleanup();
  closeSnippetPicker();
  useEditorsStore.setState({ tabs: [], activeId: undefined });
  usePanesStore.setState({ focused: {} });
  useHostsStore.setState({ panes: {} });
  useSnippetsStore.getState().reset();
});

describe('openSnippetPicker', () => {
  it('opens over the terminal tab in front, and not without one', () => {
    openSnippetPicker();
    expect(useSnippetPickerStore.getState().tabId).toBe(TAB);
    closeSnippetPicker();
    useEditorsStore.setState({ activeId: undefined });
    openSnippetPicker();
    expect(useSnippetPickerStore.getState().tabId).toBeUndefined();
  });
});

describe('the terminal picker', () => {
  const input = (): HTMLElement => screen.getByTestId('snippet-picker-input');
  const names = (): (string | undefined)[] =>
    screen.queryAllByTestId('snippet-picker-item').map((row) => row.dataset['name']);

  it("names the insert key in the platform's notation, not a Mac glyph off a Mac (#536)", () => {
    const agent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    try {
      render(<TerminalPicker onClose={() => undefined} />);
      expect(input().getAttribute('placeholder')).toBe('Run snippet · Alt+Enter inserts');
    } finally {
      agent.mockRestore();
    }
  });

  it('lists the snippets with the same matcher as the palette', () => {
    render(<TerminalPicker onClose={() => undefined} />);
    expect(names()).toEqual(['Tail logs', 'Disk usage']);
    fireEvent.change(input(), { target: { value: 'ops' } });
    expect(names()).toEqual(['Disk usage']);
  });

  it('Enter runs the chosen snippet into the terminal and closes', async () => {
    const onClose = vi.fn();
    render(<TerminalPicker onClose={onClose} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => {
      expect(runSnippet).toHaveBeenCalled();
    });
    expect(runSnippet.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's-web', snippetId: 'tail' });
    expect(runSnippet.mock.calls[0]?.[0]).not.toHaveProperty('enter');
  });

  it('⌥Enter inserts it: typed without pressing Enter', async () => {
    const onClose = vi.fn();
    render(<TerminalPicker onClose={onClose} />);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter', altKey: true });
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => {
      expect(runSnippet).toHaveBeenCalled();
    });
    expect(runSnippet.mock.calls[0]?.[0]).toMatchObject({ snippetId: 'disk', enter: false });
  });

  it('a snippet that must ask opens the run dialog instead', () => {
    useSnippetsStore.setState({ snippets: [item({ variables: [{ name: 'unit' }] })] });
    render(<TerminalPicker onClose={() => undefined} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(runSnippet).not.toHaveBeenCalled();
    expect(useRunDialogStore.getState().request).toMatchObject({ snippetId: 'tail', mode: 'variables', tabId: TAB });
  });

  it('Escape closes it without running anything', () => {
    const onClose = vi.fn();
    render(<TerminalPicker onClose={onClose} />);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(runSnippet).not.toHaveBeenCalled();
  });

  it('with no snippets it says how to add one', () => {
    useSnippetsStore.setState({ snippets: [] });
    render(<TerminalPicker onClose={() => undefined} />);
    expect(screen.getByTestId('snippet-picker-empty').textContent).toMatch(/No snippets yet/);
    fireEvent.click(screen.getByRole('button', { name: 'New snippet' }));
    expect(useSnippetsStore.getState().editor).toEqual({ mode: 'new' });
    expect(useHostsStore.getState().homeView).toBe('snippets');
  });

  it('reads the snippets when they are not loaded yet', async () => {
    useSnippetsStore.getState().reset();
    listSnippets.mockResolvedValue({
      ok: true,
      value: { file: { version: 1, packages: [], snippets: [] }, snippets: [DISK], problems: [] },
    });
    render(<TerminalPicker onClose={() => undefined} />);
    await waitFor(() => {
      expect(names()).toEqual(['Disk usage']);
    });
  });
});
