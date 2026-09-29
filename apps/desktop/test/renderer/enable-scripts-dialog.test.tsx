/**
 * **Switch on scripts…** (#63) and the explorer around it: the tree marks every container with
 * switched-off scripts beneath it, the menu offers the action there and **Clear values** on a
 * project's Values, and the dialog names what will run before it switches anything on.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { explorerMenuGroups } from '../../src/renderer/features/explorer/context-menu.js';
import { buildExplorerTree, type ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';
import {
  EnableScriptsDialog,
  enableScriptsDescription,
  useEnableScriptsDialog,
} from '../../src/renderer/features/scripts/enable-scripts-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { restApiWire, restRequestWire } from '../helpers/wire-defaults.js';

const enableScripts = vi.fn();

beforeEach(() => {
  enableScripts.mockReset().mockResolvedValue(undefined);
  installWirebenchApi();
  useProjectStore.setState({ enableScripts });
});

afterEach(() => {
  cleanup();
  useEnableScriptsDialog.getState().close();
});

const OFF = { api: 'postman' as const, enabled: false, secrets: [], pre: 'pm.test("t", () => {});' };

function tree(): ExplorerNode[] {
  const api = restApiWire({ id: 'api-1', name: 'Shop' });
  return buildExplorerTree(
    [{ id: 'p1', name: 'Demo', source: 'internal', dir: '/demo', status: 'ready' }],
    [{ projectId: 'p1', interfaceIds: [] }],
    {},
    [],
    {
      p1: {
        apis: [api],
        folders: [{ id: 'f1', apiId: 'api-1', name: 'Carts', order: 0, auth: { type: 'inherit' } } as never],
        requests: [
          restRequestWire({ id: 'r1', apiId: 'api-1', name: 'Log in', scripts: OFF }),
          restRequestWire({ id: 'r2', apiId: 'api-1', folderId: 'f1', name: 'Cart', scripts: OFF }),
          restRequestWire({ id: 'r3', apiId: 'api-1', name: 'Plain' }),
        ],
      },
    },
    undefined,
    {},
    {},
    {},
    undefined,
    {
      p1: [
        { name: 'token', secret: true },
        { name: 'region', value: 'eu', secret: false },
      ],
    },
  );
}

function find(nodes: readonly ExplorerNode[], id: string): ExplorerNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inside = find(node.children ?? [], id);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

describe('the explorer', () => {
  it('marks an API and a folder with the requests beneath them whose scripts are off', () => {
    const nodes = tree();
    expect(find(nodes, 'api:api-1')?.scriptsOff).toEqual(['r2', 'r1']);
    expect(find(nodes, 'folder:f1')?.scriptsOff).toEqual(['r2']);
  });

  it("lists a project's session values last, a secret one without its value", () => {
    const values = find(tree(), 'values:p1');
    expect(values?.children?.map((child) => child.label)).toEqual(['token (secret)', 'region = eu']);
  });

  it('offers Switch on scripts… where scripts are off, and Clear values on the Values group', () => {
    const nodes = tree();
    const labels = (id: string): string[] =>
      explorerMenuGroups(find(nodes, id)!).flatMap((group) => group.map((item) => item.label));
    expect(labels('api:api-1')).toContain('Switch on scripts…');
    expect(labels('folder:f1')).toContain('Switch on scripts…');
    expect(labels('values:p1')).toEqual(['Clear values']);
  });

  it('opens the dialog with the requests beneath', () => {
    const item = explorerMenuGroups(find(tree(), 'folder:f1')!)
      .flat()
      .find((entry) => entry.key === 'enable-scripts');
    item?.run();
    expect(useEnableScriptsDialog.getState().requestIds).toEqual(['r2']);
  });
});

describe('the dialog', () => {
  it('names what will run, and switches them on when confirmed', () => {
    useProjectStore.setState({
      restRequests: {
        r1: restRequestWire({ id: 'r1', name: 'Log in' }),
        r2: restRequestWire({ id: 'r2', name: 'Cart' }),
      },
    });
    render(<EnableScriptsDialog />);
    act(() => {
      useEnableScriptsDialog.getState().open(['r1', 'r2']);
    });

    expect(screen.getByTestId('enable-scripts-dialog').textContent).toContain(
      'The scripts of 2 requests will run on every send from now on: "Log in", "Cart".',
    );
    fireEvent.click(screen.getByTestId('enable-scripts-confirm'));
    expect(enableScripts).toHaveBeenCalledWith(['r1', 'r2']);
  });

  it('shortens a long list', () => {
    const names = Array.from({ length: 10 }, (_, i) => `R${String(i)}`);
    expect(enableScriptsDescription(names)).toContain('"R7" and 2 more');
    expect(enableScriptsDescription(['One'])).toContain('The scripts of one request');
  });
});
