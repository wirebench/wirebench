import { beforeEach, describe, expect, it } from 'vitest';
import { explorerMenuGroups, explorerMenuItems } from '../../src/renderer/features/explorer/context-menu.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

function node(patch: Partial<ExplorerNode> & Pick<ExplorerNode, 'kind'>): ExplorerNode {
  return { id: 'n1', label: 'Node', ...patch };
}

/** The reveal item's label is the platform's own word for its file manager. */
const REVEAL = /mac/i.test(navigator.userAgent)
  ? 'Reveal in Finder'
  : /win/i.test(navigator.userAgent)
    ? 'Reveal in Explorer'
    : 'Show in file manager';

describe('explorerMenuItems', () => {
  beforeEach(() => {
    useUiStore.setState({ selection: undefined, importDialogOpen: false, confirmRemoveProjectId: undefined });
  });

  it('offers the project operations on a project root', () => {
    const items = explorerMenuItems(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' }));

    expect(items.map((item) => item.label)).toEqual([
      'Import WSDL…',
      'Settings…',
      REVEAL,
      'Export project…',
      'Rename',
      'Remove from workspace',
    ]);
  });

  it('offers a linked project its own environments, and neither project a way to remove files', () => {
    const internal = explorerMenuItems(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' }));
    const linked = explorerMenuItems(node({ kind: 'project', id: 'proj:p2', projectId: 'p2', linked: true }));

    // The one difference between the two menus: only a linked project has environments of its
    // own — an internal project's environments are the workspace's, edited in the grid.
    expect(linked.map((item) => item.label)).toEqual([
      'Import WSDL…',
      'Settings…',
      'Project environments (linked project)',
      REVEAL,
      'Export project…',
      'Rename',
      'Remove from workspace',
    ]);
    expect(internal.some((item) => item.key === 'project-environments')).toBe(false);
    // Trashing the folder is a choice inside the remove confirmation, and only an internal
    // project is ever offered it — the menu itself never removes files from either. The reveal
    // item is exempt from the wording check, not from the rule: its neutral label ("Show in file
    // manager", what this menu says on anything that is not macOS or Windows) names a file
    // without touching one.
    for (const items of [internal, linked]) {
      const wording = items.filter((item) => item.key !== 'reveal').map((item) => item.label);
      expect(wording.some((label) => /file|trash|delete/i.test(label))).toBe(false);
    }
  });

  it('offers only Locate… and Remove on the row of a project whose folder is gone', () => {
    const items = explorerMenuItems(node({ kind: 'project-missing', id: 'projmissing:p1', projectId: 'p1' }));

    expect(items.map((item) => item.label)).toEqual(['Locate…', 'Remove from workspace']);
  });

  it('keeps the interface, operation, request and endpoint menus', () => {
    expect(explorerMenuItems(node({ kind: 'interface', interfaceId: 'i1' })).map((item) => item.label)).toEqual([
      'Show Interface Viewer',
      'Update Definition…',
      'Export Definition…',
      'Generate Documentation…',
      'Check WSDL WS-I compliance',
      'Copy definition URL',
      'Import another WSDL…',
      'Remove interface',
    ]);
    expect(explorerMenuItems(node({ kind: 'operation' })).map((item) => item.label)).toEqual([
      'New request',
      'Copy SOAPAction',
    ]);
    expect(explorerMenuItems(node({ kind: 'request', requestId: 'r1' })).map((item) => item.label)).toEqual([
      'Recreate request (keep values)',
      'Recreate (discard values)',
      'Create empty',
      'Clone',
      'Rename…',
      'Delete',
    ]);
    expect(explorerMenuItems(node({ kind: 'endpoint', address: 'http://x' })).map((item) => item.label)).toEqual([
      'Copy address',
    ]);
    // A grouping row has nothing to offer, and so renders no menu at all.
    expect(explorerMenuItems(node({ kind: 'operations' }))).toHaveLength(0);
  });

  it('groups a request menu so recreating and naming are each their own block, with no Open', () => {
    expect(
      explorerMenuGroups(node({ kind: 'request', requestId: 'r1' })).map((group) => group.map((i) => i.key)),
    ).toEqual([
      // No 'open': a single click on the row already opens the request.
      ['recreate', 'recreate-discard', 'recreate-empty'],
      ['clone', 'rename', 'delete'],
    ]);
  });

  it('never draws a rule against nothing: an internal project has no environments group', () => {
    const internal = explorerMenuGroups(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' }));
    const linked = explorerMenuGroups(node({ kind: 'project', id: 'proj:p2', projectId: 'p2', linked: true }));

    expect(internal.every((group) => group.length > 0)).toBe(true);
    expect(internal.map((group) => group.map((i) => i.key))).toEqual([
      ['import'],
      ['settings'],
      ['reveal', 'export'],
      ['rename', 'remove'],
    ]);
    // Only the second group differs — the linked project's own environments join Settings.
    expect(linked[1]?.map((i) => i.key)).toEqual(['settings', 'project-environments']);
  });

  it('Import WSDL… selects the project first, so the dialog opens on it', () => {
    const items = explorerMenuItems(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' }));
    items.find((item) => item.label === 'Import WSDL…')?.run();

    expect(useUiStore.getState().selection).toEqual({ kind: 'project', id: 'p1' });
    expect(useUiStore.getState().importDialogOpen).toBe(true);
  });

  it('Remove from workspace only opens the confirmation', () => {
    const items = explorerMenuItems(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' }));
    items.find((item) => item.label === 'Remove from workspace')?.run();

    expect(useUiStore.getState().confirmRemoveProjectId).toBe('p1');
  });
});
