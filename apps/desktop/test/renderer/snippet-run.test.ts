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
  expandTargets,
  invalidValue,
  needsDialog,
  openTerminals,
  runInTerminal,
  runOnTargets,
  runSummary,
  SnippetRunError,
} from '../../src/renderer/features/ssh/snippets/run.js';
import { __dispatchForTest } from '../../src/renderer/features/ssh/terminal-session.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
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

describe('several hosts (Task 11)', () => {
  const host = (id: string, path: string[], tags: string[] = [], name = id) => ({
    id,
    name,
    address: `${id}.example`,
    tags,
    path,
    protected: { value: false, source: 'default' },
  });
  const RESOLVED = [
    host('web', ['prod']),
    host('db', ['prod', 'inner']),
    host('api-1', [], ['api']),
    host('api-4', [], ['api']),
    host('lab', ['test']),
  ];

  /** The pane of the tab a run opened for the host (not the fixture's own tab). */
  const openedPane = (hostId: string): string | undefined => {
    for (const tab of useEditorsStore.getState().tabs) {
      if (tab.id === 'ssh-terminal:t1' || tab.panes?.kind !== 'pane') continue;
      if (tab.panes.hostId === hostId) return tab.panes.paneId;
    }
    return undefined;
  };
  const connected = (hostId: string, sessionId: string): void => {
    const paneId = openedPane(hostId);
    if (paneId === undefined) throw new Error(`no tab opened for ${hostId}`);
    useHostsStore.getState().setPane(paneId, { hostId, sessionId, state: 'open' });
  };
  const output = (sessionId: string, text = '$ '): void => {
    __dispatchForTest('ssh.data', { sessionId, data: btoa(text) });
  };
  const wroteTo = (): string[] => runSnippet.mock.calls.map((c) => (c[0] as { sessionId: string }).sessionId);

  beforeEach(() => {
    vi.useFakeTimers();
    useHostsStore.setState({ resolved: RESOLVED as never, trustPrompt: null, connectFailed: {} });
    useProblemsStore.setState({ items: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('expandTargets', () => {
    it('expands a group to its hosts and its subgroups’ hosts, a tag to every host carrying it', () => {
      expect(expandTargets([{ kind: 'group', id: 'prod' }], RESOLVED as never).map((h) => h.id)).toEqual(['web', 'db']);
      expect(expandTargets([{ kind: 'tag', id: 'api' }], RESOLVED as never).map((h) => h.id)).toEqual([
        'api-1',
        'api-4',
      ]);
    });
    it('lists each host once, in tree order, and skips what no longer exists', () => {
      const targets = [
        { kind: 'host', id: 'api-4' },
        { kind: 'tag', id: 'api' },
        { kind: 'group', id: 'inner' },
        { kind: 'host', id: 'gone' },
      ] as const;
      expect(expandTargets(targets, RESOLVED as never).map((h) => h.id)).toEqual(['db', 'api-1', 'api-4']);
    });
  });

  it('reuses an open connected terminal on the host, opening nothing', async () => {
    const report = await runOnTargets(item(), {}, [], [{ kind: 'host', id: 'db' }]);
    expect(wroteTo()).toEqual(['s-db']);
    expect(report).toEqual({ ok: ['db'], failed: [] });
    expect(useEditorsStore.getState().tabs).toHaveLength(1);
  });

  it('runs a host once when it is both a chosen terminal and in a chosen group', async () => {
    const report = await runOnTargets(
      item(),
      {},
      [{ kind: 'terminal', tabId: 'ssh-terminal:t1' }],
      [
        { kind: 'host', id: 'db' },
        { kind: 'group', id: 'inner' },
      ],
    );
    expect(wroteTo()).toEqual(['s-db']);
    expect(report.ok).toEqual(['db']);
  });

  it('opens a tab for a host with no terminal and writes after output then 250 ms quiet', async () => {
    const run = runOnTargets(item(), {}, [], [{ kind: 'host', id: 'lab' }]);
    await vi.advanceTimersByTimeAsync(0);
    connected('lab', 's-lab');
    await vi.advanceTimersByTimeAsync(1000);
    expect(runSnippet).not.toHaveBeenCalled(); // no output yet: the shell has not printed its prompt
    output('s-lab', 'Welcome\r\n');
    await vi.advanceTimersByTimeAsync(200);
    output('s-lab', '$ ');
    await vi.advanceTimersByTimeAsync(200);
    expect(runSnippet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(wroteTo()).toEqual(['s-lab']);
    expect(await run).toEqual({ ok: ['lab'], failed: [] });
  });

  it('writes after 10 s when a new session never prints', async () => {
    const run = runOnTargets(item(), {}, [], [{ kind: 'host', id: 'lab' }]);
    await vi.advanceTimersByTimeAsync(0);
    connected('lab', 's-silent');
    await vi.advanceTimersByTimeAsync(9_900);
    expect(runSnippet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(wroteTo()).toEqual(['s-silent']);
    await run;
  });

  it('runs targets in parallel: a slow connect does not hold back another host', async () => {
    const run = runOnTargets(item(), {}, [], [{ kind: 'tag', id: 'api' }]);
    await vi.advanceTimersByTimeAsync(0);
    connected('api-4', 's-api-4');
    output('s-api-4');
    await vi.advanceTimersByTimeAsync(300);
    expect(wroteTo()).toEqual(['s-api-4']); // api-1 is still connecting
    connected('api-1', 's-api-1');
    output('s-api-1');
    await vi.advanceTimersByTimeAsync(300);
    expect(wroteTo()).toEqual(['s-api-4', 's-api-1']);
    expect((await run).ok).toEqual(['api-1', 'api-4']);
  });

  it('a host on the trust prompt runs after the click, and is reported failed when the prompt is dismissed', async () => {
    const run = runOnTargets(
      item(),
      {},
      [],
      [
        { kind: 'tag', id: 'api' },
        { kind: 'host', id: 'lab' },
      ],
    );
    await vi.advanceTimersByTimeAsync(0);
    const prompt = { host: 'x', keyType: 'ssh-ed25519', fingerprint: 'SHA256:x' };
    useHostsStore.getState().setTrustPrompt({ paneId: openedPane('api-1') ?? '', hostId: 'api-1', ...prompt });
    connected('api-4', 's-api-4');
    output('s-api-4');
    connected('lab', 's-lab');
    output('s-lab');
    await vi.advanceTimersByTimeAsync(300);
    expect(wroteTo()).toEqual(['s-api-4', 's-lab']); // the others did not wait for the prompt
    useHostsStore.getState().cancelTrust();
    const report = await run;
    expect(report.ok).toEqual(['api-4', 'lab']);
    expect(report.failed).toEqual([{ hostId: 'api-1', message: 'The host key was not trusted' }]);
  });

  it("a host whose sign-in fails is reported with the connect's message", async () => {
    const run = runOnTargets(item(), {}, [], [{ kind: 'host', id: 'api-4' }]);
    await vi.advanceTimersByTimeAsync(0);
    const paneId = openedPane('api-4') ?? '';
    useHostsStore.getState().setPane(paneId, { hostId: 'api-4', state: 'connecting' });
    useHostsStore.getState().setPane(paneId, undefined);
    useHostsStore.getState().noteConnectFailed(paneId);
    useProblemsStore.getState().add([
      {
        groupId: 'ssh:api-4',
        source: 'hosts',
        severity: 'error',
        problem: { code: 'ssh-auth-failed', message: 'authentication failed' },
      },
    ]);
    expect(await run).toEqual({ ok: [], failed: [{ hostId: 'api-4', message: 'authentication failed' }] });
    expect(runSnippet).not.toHaveBeenCalled();
  });

  it('a terminal that reconnected gets the write on its new session; one that closed is reported failed', async () => {
    useEditorsStore.setState({
      tabs: [
        ...useEditorsStore.getState().tabs,
        {
          id: 'ssh-terminal:t2',
          kind: 'ssh-terminal',
          title: 'lab',
          panes: { kind: 'pane', paneId: 'p3', hostId: 'lab' },
        },
      ] as never,
    });
    useHostsStore.getState().setPane('p3', { hostId: 'lab', sessionId: 's-lab', state: 'open' });
    const terminals = [
      { kind: 'terminal', tabId: 'ssh-terminal:t1' },
      { kind: 'terminal', tabId: 'ssh-terminal:t2', hostId: 'lab' },
    ] as const;
    // Between choosing and running: t1's pane reconnected, t2 was closed.
    useHostsStore.getState().setPane('p2', { hostId: 'db', sessionId: 's-db-2', state: 'open' });
    useEditorsStore.setState({ tabs: useEditorsStore.getState().tabs.filter((t) => t.id !== 'ssh-terminal:t2') });
    const report = await runOnTargets(item(), {}, terminals, []);
    expect(wroteTo()).toEqual(['s-db-2']);
    expect(report).toEqual({ ok: ['db'], failed: [{ hostId: 'lab', message: 'The terminal was closed' }] });
  });

  it('a refusal from main fails only its own host', async () => {
    runSnippet.mockImplementation((r: { sessionId: string }) =>
      Promise.resolve(
        r.sessionId === 's-db'
          ? { ok: false, error: { code: 'secret-missing', message: 'no secret' } }
          : { ok: true, value: {} },
      ),
    );
    const run = runOnTargets(
      item(),
      {},
      [],
      [
        { kind: 'host', id: 'db' },
        { kind: 'host', id: 'lab' },
      ],
    );
    await vi.advanceTimersByTimeAsync(0);
    connected('lab', 's-lab');
    output('s-lab');
    await vi.advanceTimersByTimeAsync(300);
    expect(await run).toEqual({ ok: ['lab'], failed: [{ hostId: 'db', message: 'no secret' }] });
  });

  it('remembers the host targets of a run', async () => {
    await runOnTargets(item({ id: 'z' }), { x: '1' }, [], [{ kind: 'host', id: 'db' }]);
    expect(lastTargets('z')).toEqual([{ kind: 'host', id: 'db' }]);
    expect(lastValues('z')).toEqual({ x: '1' });
  });

  it('sums a run up in one line', () => {
    expect(
      runSummary({
        ok: ['api-1', 'api-2', 'api-3'],
        failed: [{ hostId: 'api-4', message: 'authentication failed' }],
      }),
    ).toBe('Ran on 3 of 4 hosts · api-4: authentication failed');
    expect(runSummary({ ok: ['web', 'db'], failed: [] })).toBe('Ran on 2 hosts');
    expect(runSummary({ ok: ['web'], failed: [] })).toBe('Ran on web');
  });
});
