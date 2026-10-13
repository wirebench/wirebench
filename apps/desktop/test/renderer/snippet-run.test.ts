import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSnippet = vi.fn();
const listSnippets = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { runSnippet, listSnippets } }),
}));
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { usePanesStore } from '../../src/renderer/features/ssh/panes/pane-actions.js';
import type { PaneNode } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import {
  invalidValue,
  needsDialog,
  openTerminals,
  runInTerminal,
  SnippetRunError,
} from '../../src/renderer/features/ssh/snippets/run.js';
import {
  lastTargets,
  lastValues,
  recentSnippetIds,
  rememberRun,
} from '../../src/renderer/features/ssh/snippets/snippets-prefs.js';
import { trackPaneModes } from '../../src/renderer/features/ssh/terminal-modes.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { SnippetListItemWire } from '../../src/shared/snippets-wire.js';

const item = (over: Partial<SnippetListItemWire> = {}): SnippetListItemWire => ({
  id: 'tail',
  name: 'Tail',
  tags: [],
  firstLine: 'tail -f x',
  literalStart: 'tail -f x',
  variables: [],
  secrets: [],
  enter: true,
  confirm: false,
  lineCount: 1,
  revision: 'rev-1',
  ...over,
});

const SPLIT: PaneNode = {
  kind: 'split',
  dir: 'row',
  ratio: 0.5,
  a: { kind: 'pane', paneId: 'p1', hostId: 'web' },
  b: { kind: 'pane', paneId: 'p2', hostId: 'db' },
};

beforeEach(() => {
  localStorage.clear();
  runSnippet.mockReset().mockResolvedValue({ ok: true, value: {} });
  listSnippets.mockReset().mockResolvedValue({
    ok: true,
    value: { file: { version: 1, packages: [], snippets: [] }, snippets: [], problems: [] },
  });
  useWorkspaceStore.setState({ workspace: { id: 'w1' } as never });
  useEditorsStore.setState({
    tabs: [{ id: 'ssh-terminal:t1', kind: 'ssh-terminal', title: 'web', panes: SPLIT }] as never,
  });
  usePanesStore.setState({ focused: { 'ssh-terminal:t1': 'p2' } });
  useHostsStore.setState({
    panes: {
      p1: { hostId: 'web', sessionId: 's-web', state: 'open' },
      p2: { hostId: 'db', sessionId: 's-db', state: 'open' },
    },
  });
});
afterEach(() => {
  useEditorsStore.setState({ tabs: [] });
  usePanesStore.setState({ focused: {} });
  useHostsStore.setState({ panes: {} });
});

describe('needsDialog', () => {
  const one = { terminals: 1, hosts: 0, anyProtected: false };
  it('runs at once in one unprotected terminal with no variables and no confirm', () => {
    expect(needsDialog(item(), one)).toBe('none');
  });
  it('asks for the values first when the snippet has variables', () => {
    expect(needsDialog(item({ variables: [{ name: 'x' }] }), one)).toBe('variables');
  });
  it('shows the dialog for confirm, a protected host, two targets or none', () => {
    expect(needsDialog(item({ confirm: true }), one)).toBe('dialog');
    expect(needsDialog(item(), { ...one, anyProtected: true })).toBe('dialog');
    expect(needsDialog(item(), { ...one, hosts: 1 })).toBe('dialog');
    expect(needsDialog(item(), { terminals: 0, hosts: 0, anyProtected: false })).toBe('dialog');
  });
});

describe('invalidValue', () => {
  it('refuses a line break or any control character, and accepts plain text', () => {
    expect(invalidValue('api\nrm -rf ~')).toBe(true);
    expect(invalidValue('a\rb')).toBe(true);
    expect(invalidValue('a\tb')).toBe(true);
    expect(invalidValue('\x1b[A')).toBe(true);
    expect(invalidValue('\u0085')).toBe(true);
    expect(invalidValue('api-1 "quoted" $HOME ${x} pässwört')).toBe(false);
  });
});

describe('runInTerminal', () => {
  it("types into the tab's focused pane's session, with xterm's bracketed mode and the item's revision", async () => {
    const untrack = trackPaneModes('p2', () => true);
    try {
      await runInTerminal('ssh-terminal:t1', item(), { x: '1' }, { enter: false });
    } finally {
      untrack();
    }
    expect(runSnippet).toHaveBeenCalledWith({
      sessionId: 's-db',
      snippetId: 'tail',
      revision: 'rev-1',
      values: { x: '1' },
      bracketed: true,
      enter: false,
    });
  });

  it('a terminal with no live session is refused before main is asked', async () => {
    useHostsStore.setState({ panes: { p2: { hostId: 'db', state: 'closed' } } });
    await expect(runInTerminal('ssh-terminal:t1', item(), {})).rejects.toBeInstanceOf(SnippetRunError);
    await expect(runInTerminal('ssh-terminal:gone', item(), {})).rejects.toBeInstanceOf(SnippetRunError);
    expect(runSnippet).not.toHaveBeenCalled();
  });

  it('snippet-changed says so and re-reads the list', async () => {
    runSnippet.mockResolvedValue({ ok: false, error: { code: 'snippet-changed', message: 'The snippet "Tail" …' } });
    await expect(runInTerminal('ssh-terminal:t1', item(), {})).rejects.toMatchObject({
      code: 'snippet-changed',
      message: 'This snippet changed since it was shown',
    });
    expect(listSnippets).toHaveBeenCalled();
  });

  it("another refusal carries main's message", async () => {
    runSnippet.mockResolvedValue({ ok: false, error: { code: 'secret-missing', message: 'The secret "t" is…' } });
    await expect(runInTerminal('ssh-terminal:t1', item(), {})).rejects.toMatchObject({
      code: 'secret-missing',
      message: 'The secret "t" is…',
    });
  });

  it('remembers the values used, and the snippet as the most recent', async () => {
    await runInTerminal('ssh-terminal:t1', item({ id: 'a' }), { x: '1' });
    await runInTerminal('ssh-terminal:t1', item({ id: 'b' }), {});
    expect(lastValues('a')).toEqual({ x: '1' });
    expect(recentSnippetIds()).toEqual(['b', 'a']);
  });
});

describe('openTerminals', () => {
  it('lists each terminal tab with a live focused pane, the host it is on and whether it is protected', () => {
    useHostsStore.setState({
      resolved: [{ id: 'db', name: 'Database', protected: { value: true, source: 'host' } }] as never,
    });
    expect(openTerminals()).toEqual([
      { tabId: 'ssh-terminal:t1', paneId: 'p2', hostId: 'db', label: 'Database', protected: true },
    ]);
    useHostsStore.setState({ panes: { p2: { hostId: 'db', sessionId: 's-db', state: 'closed' } } });
    expect(openTerminals()).toEqual([]);
  });
});

describe('snippets-prefs', () => {
  it('keeps values and targets per workspace, and survives a broken store', () => {
    rememberRun('a', { x: '1' }, [{ kind: 'group', id: 'prod' }]);
    expect(lastValues('a')).toEqual({ x: '1' });
    expect(lastTargets('a')).toEqual([{ kind: 'group', id: 'prod' }]);
    useWorkspaceStore.setState({ workspace: { id: 'w2' } as never });
    expect(lastValues('a')).toEqual({});
    expect(recentSnippetIds()).toEqual([]);
    localStorage.setItem('wirebench.ssh.snippetRuns', '{not json');
    expect(lastValues('a')).toEqual({});
  });
});
