/**
 * A click on an explorer menu item stays in the menu. The menu's content is portalled, but React
 * bubbles its events through the component tree, which runs through the tree's own row wrapper:
 * a click that reached it would select and open the row, and its tab would cover the one the item
 * just opened (Run… on an API showed the API's tab, not its Runner).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ExplorerContextMenu } from '../../src/renderer/features/explorer/context-menu.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

beforeEach(() => {
  installWirebenchApi();
  useEditorsStore.getState().reset();
});

afterEach(() => cleanup());

describe('ExplorerContextMenu', () => {
  it('keeps a click on an item from reaching the row around it', async () => {
    const rowClick = vi.fn();
    render(
      // The tree's row wrapper, which selects and activates on any click that bubbles to it.
      <div onClick={rowClick}>
        <ExplorerContextMenu node={{ id: 'folder:f1', kind: 'folder', label: 'Users', apiId: 'a1', folderId: 'f1' }}>
          <div data-testid="row">Users</div>
        </ExplorerContextMenu>
      </div>,
    );
    fireEvent.contextMenu(screen.getByTestId('row'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run…' }));

    expect(rowClick).not.toHaveBeenCalled();
    expect(useEditorsStore.getState().activeId).toBe('runner:f1');
  });
});
