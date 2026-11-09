/**
 * The one order and wording every Explorer row's menu follows, the keys shown beside its entries, its
 * destructive entries last in the danger colour, and Copy link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));
const browserTab = vi.hoisted(() => ({ value: false }));
vi.mock('../../src/renderer/lib/capabilities.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isBrowserTab: () => browserTab.value,
}));

const { ExplorerContextMenu, explorerMenuGroups, explorerMultiMenuGroups } =
  await import('../../src/renderer/features/explorer/context-menu.js');
const { menuRank } = await import('../../src/renderer/features/explorer/menu-items.js');
const { entityLink, linkTab } = await import('../../src/renderer/features/explorer/copy-link.js');
const { useWorkspaceStore } = await import('../../src/renderer/state/workspace.js');
const { registerExplorerCommands } = await import('../../src/renderer/commands/register-explorer-commands.js');
const { resetCommands } = await import('../../src/renderer/lib/commands.js');
const { setKeybindingOverrides } = await import('../../src/renderer/lib/keybindings.js');
type ExplorerNode = import('../../src/renderer/features/explorer/tree-nodes.js').ExplorerNode;

function node(patch: Partial<ExplorerNode> & Pick<ExplorerNode, 'kind'>): ExplorerNode {
  return { id: 'n1', label: 'Node', ...patch };
}

/** One row of every kind that has a menu. */
const ROWS: readonly ExplorerNode[] = [
  node({ kind: 'project', projectId: 'p1', linked: true }),
  node({ kind: 'project-missing', projectId: 'p1' }),
  node({ kind: 'interface', interfaceId: 'i1' }),
  node({ kind: 'operation', interfaceId: 'i1' }),
  node({ kind: 'request', requestId: 'r1' }),
  node({ kind: 'api', apiId: 'a1', hasDefinition: true }),
  node({ kind: 'rest-request', apiId: 'a1', requestId: 'r1' }),
  node({ kind: 'folder', apiId: 'a1', folderId: 'f1' }),
  node({ kind: 'grpc-api', apiId: 'g1', hasDefinition: true }),
  node({ kind: 'grpc-request', apiId: 'g1', requestId: 'r1' }),
  node({ kind: 'ws-api', apiId: 'w1' }),
  node({ kind: 'ws-request', apiId: 'w1', requestId: 'r1' }),
  node({ kind: 'mcp-api', apiId: 's1' }),
  node({ kind: 'mcp-request', apiId: 's1', requestId: 'r1' }),
  node({ kind: 'webhook-collection', projectId: 'p1' }),
  node({ kind: 'webhook-folder', projectId: 'p1', folderId: 'f1' }),
  node({ kind: 'webhook-request', requestId: 'r1' }),
  node({ kind: 'sequence', sequenceId: 'q1' }),
  node({ kind: 'mock', mockId: 'm1' }),
  node({ kind: 'catch-url', hookId: 'h1', canEdit: true }),
  node({ kind: 'schedule', scheduleId: 's1', canEdit: true }),
];

beforeEach(() => {
  installWirebenchApi();
  browserTab.value = false;
  showToast.mockReset();
  useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'w-local' }) });
});

afterEach(() => {
  cleanup();
  setKeybindingOverrides({});
});

describe('one menu order for every row', () => {
  it.each(ROWS.map((row) => [row.kind, row] as const))(
    '%s follows Open · Run · New · Import · Copy · Rename · Settings · Export · Delete',
    (_kind, row) => {
      const ranks = explorerMenuGroups(row)
        .flat()
        .map((item) => menuRank(item.key))
        .filter((rank): rank is number => rank !== undefined);
      expect(ranks.length).toBeGreaterThan(0);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    },
  );

  it.each(ROWS.map((row) => [row.kind, row] as const))('%s says Rename… with its ellipsis', (_kind, row) => {
    for (const item of explorerMenuGroups(row).flat()) {
      if (item.key === 'rename') expect(item.label).toBe('Rename…');
    }
  });

  it('puts what deletes or removes last, after a rule of its own, marked destructive', () => {
    for (const row of ROWS) {
      const menu = explorerMenuGroups(row);
      const danger = menu.flat().filter((item) => item.destructive === true);
      if (danger.length === 0) continue;
      expect(menu.at(-1), row.kind).toEqual(danger);
      expect(menu.length, row.kind).toBeGreaterThan(1);
    }
    const project = explorerMenuGroups(node({ kind: 'project', projectId: 'p1' }));
    expect(project.at(-1)?.map((item) => [item.label, item.destructive])).toEqual([['Remove from workspace', true]]);
    const multi = explorerMultiMenuGroups([
      node({ kind: 'rest-request', id: 'rest:r1', apiId: 'a1', requestId: 'r1' }),
      node({ kind: 'rest-request', id: 'rest:r2', apiId: 'a1', requestId: 'r2' }),
    ]);
    expect(multi.at(-1)?.[0]).toMatchObject({ label: 'Delete 2 requests…', destructive: true });
  });

  it('gives every request row Open', () => {
    for (const kind of [
      'request',
      'rest-request',
      'grpc-request',
      'ws-request',
      'mcp-request',
      'webhook-request',
    ] as const) {
      const first = explorerMenuGroups(node({ kind, apiId: 'a1', requestId: 'r1' }))[0]?.[0];
      expect(first?.label, kind).toBe('Open');
    }
  });

  it('offers Duplicate API and Export API… on a REST API, Export API… only with a cached definition', () => {
    const labels = (row: ExplorerNode): string[] =>
      explorerMenuGroups(row)
        .flat()
        .map((item) => item.label);
    expect(labels(node({ kind: 'api', apiId: 'a1', hasDefinition: true }))).toEqual(
      expect.arrayContaining(['Duplicate API', 'Export API…']),
    );
    expect(labels(node({ kind: 'api', apiId: 'a1' }))).not.toContain('Export API…');
    expect(labels(node({ kind: 'grpc-api', apiId: 'g1', hasDefinition: true }))).toContain('Export API…');
    // A SOAP API's export is its WSDL.
    expect(labels(node({ kind: 'interface', interfaceId: 'i1' }))).toContain('Export API…');
  });
});

describe('keys beside the entries', () => {
  it('names the command whose key does the same to that row, and only where the key works on it', () => {
    const commandOf = (row: ExplorerNode, key: string) =>
      explorerMenuGroups(row)
        .flat()
        .find((item) => item.key === key)?.command;
    expect(commandOf(node({ kind: 'api', apiId: 'a1' }), 'rename')).toBe('explorer.rename');
    expect(commandOf(node({ kind: 'api', apiId: 'a1' }), 'delete')).toBe('explorer.delete');
    expect(commandOf(node({ kind: 'rest-request', apiId: 'a1', requestId: 'r1' }), 'duplicate')).toBe(
      'explorer.duplicate',
    );
    expect(commandOf(node({ kind: 'project', projectId: 'p1' }), 'remove')).toBe('explorer.delete');
    // The Delete key does nothing to a project whose folder is gone; its menu shows no key.
    expect(commandOf(node({ kind: 'project-missing', projectId: 'p1' }), 'remove')).toBeUndefined();
    // Send is ⌘⏎ in the editor, not on the row.
    expect(commandOf(node({ kind: 'rest-request', apiId: 'a1', requestId: 'r1' }), 'send')).toBeUndefined();
  });

  it('draws the bound key at the right of the entry, following a rebind, and the destructive entry in danger', async () => {
    resetCommands();
    registerExplorerCommands();
    setKeybindingOverrides({ 'explorer.rename': 'Mod+Alt+R' });
    render(
      <ExplorerContextMenu node={node({ kind: 'api', id: 'api:a1', apiId: 'a1' })}>
        <div data-testid="row">Pets</div>
      </ExplorerContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId('row'));

    const rename = await screen.findByRole('menuitem', { name: 'Rename…' });
    expect(rename.querySelector('[data-testid="explorer-menu-shortcut"]')?.textContent).toBe('Ctrl+Alt+R');
    expect(rename.getAttribute('aria-keyshortcuts')).toBe('Control+Alt+R');
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(remove.getAttribute('data-destructive')).toBe('true');
    expect(remove.className).toContain('text-status-danger');
    expect(remove.querySelector('[data-testid="explorer-menu-shortcut"]')?.textContent).toBe('Delete');
    // An entry with no key shows none.
    expect(
      screen.getByRole('menuitem', { name: 'Open' }).querySelector('[data-testid="explorer-menu-shortcut"]'),
    ).toBeNull();
    resetCommands();
  });
});

describe('Copy link', () => {
  const server = { url: 'https://wb.test', workspaceId: 'team-ws-1' };

  it('links a row to its tab in the browser client’s address', () => {
    expect(linkTab(node({ kind: 'rest-request', requestId: 'r1' }))).toEqual({ kind: 'rest-request', id: 'r1' });
    expect(linkTab(node({ kind: 'grpc-api', apiId: 'g1' }))).toEqual({ kind: 'grpc-api', id: 'g1' });
    expect(linkTab(node({ kind: 'project', projectId: 'p1' }))).toEqual({ kind: 'project', id: 'p1' });
    expect(linkTab(node({ kind: 'folder', folderId: 'f1' }))).toBeUndefined();
    // A server workspace is named by its team workspace id, so a teammate's link opens the same one.
    expect(
      entityLink(
        'https://wb.test',
        { id: 'local-1', share: { kind: 'server', server } as never },
        { kind: 'api', id: 'a1' },
      ),
    ).toBe('https://wb.test/workspaces/team-ws-1/api/a1');
  });

  it('is offered in a browser tab, and on the desktop only for a workspace shared to a server', () => {
    const has = () =>
      explorerMenuGroups(node({ kind: 'api', apiId: 'a1' }))
        .flat()
        .some((item) => item.key === 'copy-link');
    expect(has()).toBe(false);
    browserTab.value = true;
    expect(has()).toBe(true);
    browserTab.value = false;
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'w1', share: { kind: 'server', server } as never }) });
    expect(has()).toBe(true);
  });

  it('copies the link on the desktop once the server says it serves the browser client', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const probe = vi.fn().mockResolvedValue({ ok: true, value: { meta: { capabilities: ['browser-client'] } } });
    installWirebenchApi({ account: { probe } });
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'w1', share: { kind: 'server', server } as never }) });

    explorerMenuGroups(node({ kind: 'rest-request', requestId: 'r1' }))
      .flat()
      .find((item) => item.key === 'copy-link')
      ?.run();

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://wb.test/workspaces/team-ws-1/rest-request/r1'));
    expect(probe).toHaveBeenCalledWith({ url: 'https://wb.test' });
    expect(showToast).toHaveBeenCalledWith('Link copied');
  });

  it('says so instead when the server has no browser client', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const probe = vi.fn().mockResolvedValue({ ok: true, value: { meta: { capabilities: [] } } });
    installWirebenchApi({ account: { probe } });
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'w1', share: { kind: 'server', server } as never }) });

    explorerMenuGroups(node({ kind: 'project', projectId: 'p1' }))
      .flat()
      .find((item) => item.key === 'copy-link')
      ?.run();

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('This workspace’s server has no browser client to link to'),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses the page’s own origin in a browser tab', async () => {
    browserTab.value = true;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    explorerMenuGroups(node({ kind: 'project', projectId: 'p1' }))
      .flat()
      .find((item) => item.key === 'copy-link')
      ?.run();
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/workspaces/w-local/project/p1`),
    );
  });
});
