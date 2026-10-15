import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSnippet = vi.fn();
const previewSnippet = vi.fn();
const listSnippets = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { runSnippet, previewSnippet, listSnippets } }),
}));
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { SECRET_NOTE, SnippetRunDialog } from '../../src/renderer/features/ssh/snippets/run-dialog.js';
import { startRun, useRunDialogStore } from '../../src/renderer/features/ssh/snippets/run.js';
import { lastTargets, rememberRun } from '../../src/renderer/features/ssh/snippets/snippets-prefs.js';
import { useSnippetsStore } from '../../src/renderer/features/ssh/snippets/snippets-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { SnippetListItemWire } from '../../src/shared/snippets-wire.js';

const item = (over: Partial<SnippetListItemWire> & { id: string }): SnippetListItemWire => ({
  name: over.id,
  tags: [],
  firstLine: 'ls',
  literalStart: 'ls',
  variables: [],
  secrets: [],
  enter: true,
  confirm: false,
  lineCount: 1,
  revision: 'rev',
  ...over,
});
const TAIL = item({
  id: 'tail',
  name: 'Tail log',
  firstLine: 'journalctl -u ${service} -n ${lines}',
  literalStart: 'journalctl -u ',
  variables: [
    { name: 'service', default: 'api' },
    { name: 'lines', label: 'Lines to show' },
  ],
});
const HEALTH = item({ id: 'health', name: 'Health', firstLine: 'curl -H ${secret:t} x', secrets: ['t'] });
const PLAIN = item({ id: 'plain', name: 'Plain' });

function input(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error('not an input');
  return element;
}
function button(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) throw new Error('not a button');
  return element;
}

beforeEach(() => {
  localStorage.clear();
  runSnippet.mockReset().mockResolvedValue({ ok: true, value: {} });
  previewSnippet.mockReset().mockResolvedValue({ ok: true, value: { text: 'curl -H •••• x', revision: 'rev' } });
  listSnippets.mockReset().mockResolvedValue({
    ok: true,
    value: { file: { version: 1, packages: [], snippets: [] }, snippets: [], problems: [] },
  });
  useWorkspaceStore.setState({ workspace: { id: 'w1' } as never });
  useSnippetsStore.setState({ snippets: [TAIL, HEALTH, PLAIN] });
  useEditorsStore.setState({
    tabs: [
      {
        id: 'ssh-terminal:t1',
        kind: 'ssh-terminal',
        title: 'web',
        panes: { kind: 'pane', paneId: 'p1', hostId: 'web' },
      },
    ] as never,
    activeId: undefined,
  });
  useHostsStore.setState({
    panes: { p1: { hostId: 'web', sessionId: 's1', state: 'open' } },
    resolved: [{ id: 'web', name: 'Web 1', path: [], tags: [], protected: { value: false, from: 'default' } }] as never,
  });
});
afterEach(() => {
  cleanup();
  useRunDialogStore.setState({ request: null });
  useEditorsStore.setState({ tabs: [], activeId: undefined });
  useHostsStore.setState({ panes: {}, resolved: [] });
  vi.restoreAllMocks();
});

function open(target: SnippetListItemWire, opts: { enter?: false } = {}) {
  render(<SnippetRunDialog />);
  act(() => {
    startRun(target, opts);
  });
}

describe('the run dialog for one terminal', () => {
  it('with no terminal in front, shows the dialog with the open terminal ticked and the preview from main', async () => {
    open(HEALTH);
    expect(input(screen.getByRole('checkbox', { name: 'Web 1' })).checked).toBe(true);
    await waitFor(() => expect(screen.getByTestId('snippet-run-preview').textContent).toContain('curl -H •••• x'));
    expect(previewSnippet).toHaveBeenCalledWith({ snippetId: 'health', values: {} });
    expect(screen.getByText(SECRET_NOTE)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSnippet).toHaveBeenCalled());
    expect(runSnippet.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's1', snippetId: 'health', revision: 'rev' });
    await waitFor(() => expect(useRunDialogStore.getState().request).toBeNull());
    expect(useEditorsStore.getState().activeId).toBe('ssh-terminal:t1');
  });

  it('a plain snippet has no secret note; Insert sends enter: false', async () => {
    open(PLAIN, { enter: false });
    expect(screen.queryByText(SECRET_NOTE)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(runSnippet).toHaveBeenCalled());
    expect(runSnippet.mock.calls[0]?.[0]).toMatchObject({ enter: false });
  });

  it('prefills the last values used, else the defaults', () => {
    rememberRun('tail', { lines: '50' }, []);
    open(TAIL);
    expect(input(screen.getByLabelText('service')).value).toBe('api');
    expect(input(screen.getByLabelText('Lines to show')).value).toBe('50');
  });

  it('marks an empty variable, and asks once before running with it empty', async () => {
    open(TAIL);
    expect(screen.getAllByTestId('snippet-variable-empty')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByTestId('snippet-run-empty').textContent).toBe('Lines to show is empty. Run anyway?');
    await new Promise((r) => setTimeout(r, 50));
    expect(runSnippet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }));
    await waitFor(() => expect(runSnippet).toHaveBeenCalled());
  });

  it('a filled value takes the question away', () => {
    open(TAIL);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    fireEvent.change(screen.getByLabelText('Lines to show'), { target: { value: '20' } });
    expect(screen.queryByTestId('snippet-run-empty')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run' })).toBeDefined();
  });

  it('refuses a value with a control character before main is asked', async () => {
    open(TAIL);
    // A text field drops line breaks itself (as the browser does); a tab or an escape still gets in.
    fireEvent.change(screen.getByLabelText('service'), { target: { value: 'api\trm -rf ~' } });
    expect(screen.getByRole('alert').textContent).toContain('line break');
    expect(button(screen.getByRole('button', { name: 'Run' })).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('button', { name: 'Run' }).closest('form')!);
    await new Promise((r) => setTimeout(r, 200));
    expect(runSnippet).not.toHaveBeenCalled();
    const previewed = previewSnippet.mock.calls.map((c) => (c[0] as { values: Record<string, string> }).values);
    expect(previewed.some((v) => v['service'] === 'api\trm -rf ~')).toBe(false);
  });

  it('a snippet that changed since it was shown says so and re-reads the list', async () => {
    runSnippet.mockResolvedValue({ ok: false, error: { code: 'snippet-changed', message: 'x' } });
    const changed = { ...PLAIN, revision: 'rev-2' };
    listSnippets.mockResolvedValue({
      ok: true,
      value: { file: { version: 1, packages: [], snippets: [] }, snippets: [changed], problems: [] },
    });
    open(PLAIN);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSnippet).toHaveBeenCalled());
    expect(await screen.findByText('This snippet changed since it was shown')).toBeTruthy();
    expect(listSnippets).toHaveBeenCalled();
    expect(useRunDialogStore.getState().request).not.toBeNull();
    // The next Run sends the revision now saved, after the user saw it.
    runSnippet.mockResolvedValue({ ok: true, value: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runSnippet).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 'rev-2' })));
  });

  it('names a protected host', () => {
    useHostsStore.setState({
      resolved: [{ id: 'web', name: 'Web 1', path: [], tags: [], protected: { value: true, from: 'host' } }] as never,
    });
    open(PLAIN);
    expect(screen.getByTestId('snippet-run-protected').textContent).toBe('Web 1 is protected');
  });
});

describe('startRun with a terminal in front', () => {
  beforeEach(() => {
    useEditorsStore.setState({ activeId: 'ssh-terminal:t1' });
  });

  it('runs at once when nothing needs asking', async () => {
    open(PLAIN);
    await waitFor(() => expect(runSnippet).toHaveBeenCalled());
    expect(useRunDialogStore.getState().request).toBeNull();
  });

  it('asks only for the values when the snippet has variables', () => {
    open(TAIL);
    expect(screen.getByLabelText('service')).toBeTruthy();
    expect(screen.queryByTestId('snippet-run-preview')).toBeNull();
    expect(runSnippet).not.toHaveBeenCalled();
  });

  it('shows the whole dialog for confirm: true', () => {
    const careful = item({ id: 'c', confirm: true });
    useSnippetsStore.setState({ snippets: [careful] });
    open(careful);
    expect(screen.getByTestId('snippet-run-preview')).toBeTruthy();
  });
});

describe('the run dialog for several hosts', () => {
  const host = (id: string, name: string, path: string[], tags: string[] = [], prot?: { group: string } | 'host') => ({
    id,
    name,
    address: `${id}.example`,
    path,
    tags,
    protected: prot === undefined ? { value: false, from: 'default' } : { value: true, from: prot },
  });
  const FILE = {
    version: 1,
    groups: [
      { id: 'prod', name: 'Production', groups: [{ id: 'inner', name: 'Inner', groups: [], hosts: [] }], hosts: [] },
    ],
    hosts: [],
  };

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    useHostsStore.setState({
      file: FILE as never,
      resolved: [
        host('web', 'Web 1', ['prod']),
        host('db', 'DB', ['prod', 'inner'], [], { group: 'prod' }),
        host('api', 'API', [], ['edge']),
      ] as never,
    });
  });

  const addTarget = (search: string, option: string): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Add host, group or tag' }));
    fireEvent.change(screen.getByTestId('snippet-run-target-input'), { target: { value: search } });
    fireEvent.click(screen.getByRole('option', { name: option }));
  };

  it('adds a group as a chip that shows the hosts it expands to', () => {
    open(PLAIN);
    addTarget('Prod', 'Group Production');
    const chip = screen.getByTestId('snippet-run-chip');
    expect(chip.textContent).toContain('Production');
    expect(chip.textContent).toContain('Web 1, DB');
  });

  it('names every protected target with where it comes from', () => {
    open(PLAIN);
    addTarget('Prod', 'Group Production');
    expect(screen.getByTestId('snippet-run-protected').textContent).toBe('DB is protected (from Production)');
  });

  it('counts each host once in the button, and has none to run with no target', () => {
    open(PLAIN);
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy(); // the ticked terminal on Web 1
    addTarget('Prod', 'Group Production'); // Web 1 again, and DB
    expect(screen.getByRole('button', { name: 'Run on 2 hosts' })).toBeTruthy();
    addTarget('edge', 'Tag edge');
    expect(screen.getByRole('button', { name: 'Run on 3 hosts' })).toBeTruthy();
    for (const remove of screen.getAllByRole('button', { name: /^Remove / })) fireEvent.click(remove);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Web 1' }));
    expect(button(screen.getByRole('button', { name: 'Run' })).disabled).toBe(true);
  });

  it('prefills the last targets', () => {
    rememberRun('plain', {}, [{ kind: 'tag', id: 'edge' }]);
    open(PLAIN);
    expect(screen.getByTestId('snippet-run-chip').textContent).toContain('API');
  });

  it('Escape cancels and nothing runs', async () => {
    open(PLAIN);
    fireEvent.keyDown(screen.getByTestId('snippet-run-dialog'), { key: 'Escape' });
    await waitFor(() => expect(useRunDialogStore.getState().request).toBeNull());
    expect(runSnippet).not.toHaveBeenCalled();
  });

  it('Escape in the picker closes only the picker', () => {
    open(PLAIN);
    fireEvent.click(screen.getByRole('button', { name: 'Add host, group or tag' }));
    fireEvent.keyDown(screen.getByTestId('snippet-run-target-input'), { key: 'Escape' });
    expect(screen.queryByTestId('snippet-run-target-input')).toBeNull();
    expect(useRunDialogStore.getState().request).not.toBeNull();
  });

  it('runs on every host, remembers the targets and closes', async () => {
    useEditorsStore.setState({
      tabs: [
        ...useEditorsStore.getState().tabs,
        {
          id: 'ssh-terminal:t2',
          kind: 'ssh-terminal',
          title: 'DB',
          panes: { kind: 'pane', paneId: 'p2', hostId: 'db' },
        },
      ] as never,
    });
    useHostsStore.setState({
      panes: {
        p1: { hostId: 'web', sessionId: 's1', state: 'open' },
        p2: { hostId: 'db', sessionId: 's2', state: 'open' },
      },
    });
    open(PLAIN);
    fireEvent.click(screen.getByRole('checkbox', { name: 'DB' })); // untick: the group brings DB back
    addTarget('Prod', 'Group Production');
    fireEvent.click(screen.getByRole('button', { name: 'Run on 2 hosts' }));
    await waitFor(() => expect(runSnippet).toHaveBeenCalledTimes(2));
    const sessions = runSnippet.mock.calls.map((c) => (c[0] as { sessionId: string }).sessionId).sort();
    expect(sessions).toEqual(['s1', 's2']);
    expect(useRunDialogStore.getState().request).toBeNull();
    expect(lastTargets('plain')).toEqual([{ kind: 'group', id: 'prod' }]);
  });
});
