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
      'Import OpenAPI…',
      'New API…',
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
      'Import OpenAPI…',
      'New API…',
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
      ['import', 'import-openapi', 'new-api'],
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

  it('Import OpenAPI… does the same for its own dialog', () => {
    const items = explorerMenuItems(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' }));
    items.find((item) => item.label === 'Import OpenAPI…')?.run();

    expect(useUiStore.getState().selection).toEqual({ kind: 'project', id: 'p1' });
    expect(useUiStore.getState().importOpenApiDialogOpen).toBe(true);
    // The two dialogs are independent: opening one must not open the other.
    expect(useUiStore.getState().importDialogOpen).toBe(false);
  });

  it('Remove from workspace only opens the confirmation', () => {
    const items = explorerMenuItems(node({ kind: 'project', id: 'proj:p1', projectId: 'p1' }));
    items.find((item) => item.label === 'Remove from workspace')?.run();

    expect(useUiStore.getState().confirmRemoveProjectId).toBe('p1');
  });
});

/**
 * The REST rows. The point of each case is what the menu does *not* offer: an API row has no
 * *Recreate* (there is no definition to recreate from), a folder has nothing to open, and a request
 * row has no *Open* because a single click already opens it.
 */
describe('explorerMenuItems on a REST row', () => {
  it('offers an API its containers and its own lifecycle', () => {
    const items = explorerMenuItems(node({ kind: 'api', id: 'api:a1', apiId: 'a1' }));

    expect(items.map((item) => item.label)).toEqual([
      'Open',
      'New folder',
      'New request',
      'Import cURL…',
      'Rename…',
      'Delete',
    ]);
  });

  it('offers a folder the two creators, a rename, its credentials and a delete', () => {
    const items = explorerMenuItems(node({ kind: 'folder', id: 'folder:f1', apiId: 'a1', folderId: 'f1' }));

    expect(items.map((item) => item.label)).toEqual([
      'New folder',
      'New request',
      'Import cURL…',
      'Rename…',
      'Auth…',
      'Delete',
    ]);
  });

  it('Auth… opens the folder credentials dialog, which is a folder’s only editable field', () => {
    const items = explorerMenuItems(node({ kind: 'folder', id: 'folder:f1', apiId: 'a1', folderId: 'f1' }));
    items.find((item) => item.label === 'Auth…')?.run();

    expect(useUiStore.getState().folderAuthId).toBe('f1');
  });

  it('offers a REST request duplicate, rename and delete, and no Open', () => {
    const items = explorerMenuItems(node({ kind: 'rest-request', id: 'rest:r1', apiId: 'a1', requestId: 'r1' }));

    expect(items.map((item) => item.label)).toEqual(['Duplicate', 'Rename…', 'Delete']);
  });

  it('keeps the destructive entry in a group of its own on all three', () => {
    for (const kinds of [
      node({ kind: 'api', id: 'api:a1', apiId: 'a1' }),
      node({ kind: 'folder', id: 'folder:f1', apiId: 'a1', folderId: 'f1' }),
      node({ kind: 'rest-request', id: 'rest:r1', apiId: 'a1', requestId: 'r1' }),
    ]) {
      const groups = explorerMenuGroups(kinds);
      expect(groups.at(-1)?.map((item) => item.label)).toEqual(['Delete']);
    }
  });

  it('offers nothing for a row whose ids are missing, rather than items that would no-op', () => {
    expect(explorerMenuItems(node({ kind: 'api' }))).toEqual([]);
    expect(explorerMenuItems(node({ kind: 'folder', apiId: 'a1' }))).toEqual([]);
    expect(explorerMenuItems(node({ kind: 'rest-request', apiId: 'a1' }))).toEqual([]);
  });

  it('Import cURL… on an API points the dialog at it, and on a folder at the folder', () => {
    const api = explorerMenuItems(node({ kind: 'api', id: 'api:a1', apiId: 'a1' }));
    api.find((item) => item.label === 'Import cURL…')?.run();
    expect(useUiStore.getState().importCurlTarget).toEqual({ kind: 'rest', apiId: 'a1' });

    const folder = explorerMenuItems(node({ kind: 'folder', id: 'folder:f1', apiId: 'a1', folderId: 'f1' }));
    folder.find((item) => item.label === 'Import cURL…')?.run();
    expect(useUiStore.getState().importCurlTarget).toEqual({ kind: 'rest', apiId: 'a1', folderId: 'f1' });
  });
});
