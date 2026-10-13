import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listHosts = vi.fn();
const listSnippets = vi.fn();
const saveSnippets = vi.fn();
const secretNames = vi.fn(() => Promise.resolve({ ok: true, value: { names: [] } }));
const knownHosts = vi.fn(() => Promise.resolve({ ok: true, value: { entries: [] } }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, listSnippets, saveSnippets, secretNames, knownHosts } }),
}));
import { HostsView } from '../../src/renderer/features/ssh/hosts-view.js';
import { SshHome } from '../../src/renderer/features/ssh/ssh-home.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import {
  filterSnippets,
  subscribeToSnippets,
  useSnippetsStore,
} from '../../src/renderer/features/ssh/snippets/snippets-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import type { SnippetListItemWire, SnippetsFileWire, SshListSnippetsResponse } from '../../src/shared/snippets-wire.js';

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
  revision: 'r',
  ...over,
});

const snippet = (id: string, script: string, over: object = {}) => ({
  id,
  name: id,
  tags: [],
  variables: [],
  script,
  enter: true,
  confirm: false,
  ...over,
});

const FILE: SnippetsFileWire = {
  version: 1,
  packages: [
    {
      id: 'deploy',
      name: 'Deploy',
      snippets: [
        snippet('restart-api', 'sudo systemctl restart api', { name: 'Restart API', tags: ['deploy'], confirm: true }),
        snippet('tail-log', 'journalctl -u ${service} -f', {
          name: 'Tail log',
          tags: ['logs'],
          variables: [{ name: 'service', default: 'api' }],
        }),
      ],
    },
    { id: 'empty', name: 'Empty', snippets: [] },
  ],
  snippets: [snippet('health', 'curl -H "${secret:token}" x\necho', { name: 'Health', tags: ['logs'] })],
};
const LIST: SnippetListItemWire[] = [
  item({
    id: 'restart-api',
    name: 'Restart API',
    packageId: 'deploy',
    packageName: 'Deploy',
    tags: ['deploy'],
    firstLine: 'sudo systemctl restart api',
    confirm: true,
  }),
  item({
    id: 'tail-log',
    name: 'Tail log',
    packageId: 'deploy',
    packageName: 'Deploy',
    tags: ['logs'],
    firstLine: 'journalctl -u ${service} -f',
    variables: [{ name: 'service', default: 'api' }],
  }),
  item({ id: 'health', name: 'Health', tags: ['logs'], firstLine: 'curl -H "${secret:token}" x', secrets: ['token'] }),
];
const ANSWER: SshListSnippetsResponse = { file: FILE, snippets: LIST, problems: [] };

beforeEach(() => {
  listHosts.mockResolvedValue({
    ok: true,
    value: { file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] },
  });
  listSnippets.mockResolvedValue({ ok: true, value: ANSWER });
  saveSnippets.mockResolvedValue({ ok: true, value: ANSWER });
  useSnippetsStore.getState().reset();
  useSnippetsStore.setState({ filter: '', selectedTags: [] });
  useHostsStore.setState({ homeView: 'snippets' });
  useProblemsStore.getState().clearSource('snippets');
});
afterEach(cleanup);

describe('filterSnippets', () => {
  it('matches text case-insensitively over name, description, first line, tags and package', () => {
    const withDescription = [...LIST, item({ id: 'x', name: 'X', description: 'Rotates the LOGS' })];
    const ids = (text: string) => filterSnippets(withDescription, text, []).map((s) => s.id);
    expect(ids('restart')).toEqual(['restart-api']);
    expect(ids('JOURNALCTL')).toEqual(['tail-log']);
    expect(ids('deploy')).toEqual(['restart-api', 'tail-log']);
    expect(ids('rotates')).toEqual(['x']);
    expect(ids('  ')).toEqual(['restart-api', 'tail-log', 'health', 'x']);
  });
  it('keeps only snippets holding every chosen tag', () => {
    expect(filterSnippets(LIST, '', ['logs']).map((s) => s.id)).toEqual(['tail-log', 'health']);
    expect(filterSnippets(LIST, '', ['logs', 'deploy'])).toEqual([]);
    expect(filterSnippets(LIST, 'health', ['logs']).map((s) => s.id)).toEqual(['health']);
  });
});

describe('snippets store', () => {
  it('refresh fills the store and reports problems in the Problems tab as source snippets', async () => {
    listSnippets.mockResolvedValue({
      ok: true,
      value: { ...ANSWER, problems: [{ code: 'snippets-invalid', message: 'bad', path: 'snippets[0].id' }] },
    });
    await useSnippetsStore.getState().refresh();
    expect(useSnippetsStore.getState().snippets).toHaveLength(3);
    expect(useProblemsStore.getState().items.filter((p) => p.source === 'snippets')).toMatchObject([
      { problem: { code: 'snippets-invalid', location: 'snippets[0].id' } },
    ]);
  });
  it('save answers the refusal without touching the file shown', async () => {
    await useSnippetsStore.getState().refresh();
    saveSnippets.mockResolvedValue({ ok: false, error: { code: 'snippet-duplicate-id', message: 'twice' } });
    const answer = await useSnippetsStore.getState().save(FILE);
    expect(answer).toEqual({ ok: false, error: { code: 'snippet-duplicate-id', message: 'twice' } });
    expect(useSnippetsStore.getState().file).toEqual(FILE);
  });
  it('re-lists on ssh.snippetsChanged and swallows a failed refresh', async () => {
    let listener: (() => void) | undefined;
    const on = vi.fn((_name: string, fn: () => void) => {
      listener = fn;
      return () => undefined;
    });
    (window as unknown as { wirebench: { on: typeof on } }).wirebench = { on };
    const off = subscribeToSnippets();
    expect(on).toHaveBeenCalledWith('ssh.snippetsChanged', expect.any(Function));
    listSnippets.mockRejectedValueOnce(new Error('bridge gone'));
    listener?.();
    await vi.waitFor(() => {
      expect(listSnippets).toHaveBeenCalled();
    });
    off();
  });
});

describe('SSH menu', () => {
  it('shows Snippets with its count after Hosts, and picking it shows the panel in the fixed tab', async () => {
    useHostsStore.setState({ homeView: 'hosts' });
    useEditorsStore.getState().reset();
    render(
      <>
        <HostsView />
        <SshHome />
      </>,
    );
    const items = within(screen.getByRole('navigation', { name: 'SSH' })).getAllByRole('button');
    expect(items.map((b) => b.dataset['testid'])).toEqual([
      'ssh-nav-hosts',
      'ssh-nav-snippets',
      'ssh-nav-keychain',
      'ssh-nav-known-hosts',
    ]);
    await vi.waitFor(() => {
      expect(screen.getByTestId('ssh-nav-snippets').textContent).toBe('Snippets3');
    });
    await userEvent.click(screen.getByTestId('ssh-nav-snippets'));
    expect(useHostsStore.getState().homeView).toBe('snippets');
    expect(useEditorsStore.getState().displayedSet).toBe('ssh');
    expect(screen.getByRole('heading', { name: /Snippets/ })).toBeDefined();
  });
});

describe('Snippets panel', () => {
  async function renderPanel(): Promise<void> {
    render(<SshHome />);
    await screen.findByText('Restart API');
  }

  it('lists packages as sections in file order with counts, then No package', async () => {
    await renderPanel();
    const sections = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(sections).toEqual(['Deploy', 'Empty', 'No package']);
    const deploy = screen.getByRole('region', { name: 'Deploy' });
    expect(within(deploy).getByTestId('snippet-section-count').textContent).toBe('2');
    expect(
      within(deploy)
        .getAllByRole('listitem')
        .map((li) => li.dataset['snippetId']),
    ).toEqual(['restart-api', 'tail-log']);
    expect(within(screen.getByRole('region', { name: 'No package' })).getByText('Health')).toBeDefined();
  });

  it('a row shows the first line and icons for variables, secrets and confirm', async () => {
    await renderPanel();
    const row = (id: string) => screen.getByTestId(`snippet-row-${id}`);
    expect(within(row('tail-log')).getByText('journalctl -u ${service} -f')).toBeDefined();
    expect(within(row('tail-log')).getByLabelText('Has variables')).toBeDefined();
    expect(within(row('health')).getByLabelText('Uses a secret')).toBeDefined();
    expect(within(row('restart-api')).getByLabelText('Always confirms')).toBeDefined();
    expect(within(row('restart-api')).queryByLabelText('Has variables')).toBeNull();
  });

  it('tag chips and the filter narrow the list; empty sections hide while filtering', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'logs' }));
    expect(screen.queryByText('Restart API')).toBeNull();
    expect(screen.getByText('Tail log')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Empty' })).toBeNull();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter snippets' }), 'curl');
    expect(screen.queryByText('Tail log')).toBeNull();
    expect(screen.getByText('Health')).toBeDefined();
  });

  it('⌘F focuses the filter', async () => {
    await renderPanel();
    fireEvent.keyDown(window, { key: 'f', metaKey: true, ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Filter snippets' }));
  });

  it('problems show above the list', async () => {
    listSnippets.mockResolvedValue({
      ok: true,
      value: { ...ANSWER, problems: [{ code: 'snippets-invalid', message: 'could not parse', path: 'snippets[0]' }] },
    });
    await renderPanel();
    expect(within(screen.getByRole('alert', { name: 'Snippets problems' })).getByText('could not parse')).toBeDefined();
  });

  it('a section collapses and expands', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Deploy/, expanded: true }));
    expect(screen.queryByText('Restart API')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Deploy/, expanded: false }));
    expect(screen.getByText('Restart API')).toBeDefined();
  });

  it('clicking a row selects it', async () => {
    await renderPanel();
    await userEvent.click(screen.getByText('Health'));
    expect(useSnippetsStore.getState().selectedId).toBe('health');
    expect(screen.getByTestId('snippet-row-health').getAttribute('aria-current')).toBe('true');
  });
});
