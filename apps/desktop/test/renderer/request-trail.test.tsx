/** A request's path line: each part opens its own tab and shows its row in the Explorer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { requestTrail } from '../../src/renderer/features/explorer/request-trail.js';
import { registerExplorerTree } from '../../src/renderer/features/explorer/explorer-api.js';
import { RestBreadcrumb } from '../../src/renderer/features/rest-editor/rest-breadcrumb.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restApiWire, restFolderWire, restRequestWire } from '../helpers/wire-defaults.js';

const select = vi.fn();
const openParents = vi.fn();

beforeEach(() => {
  installWirebenchApi();
  useEditorsStore.getState().reset();
  select.mockReset();
  openParents.mockReset();
  registerExplorerTree({
    get: (id: string) => ({ id, isSelected: false }),
    openParents,
    select,
  } as unknown as Parameters<typeof registerExplorerTree>[0]);
  useProjectStore.setState({
    projects: { p1: { id: 'p1', name: 'Shop' } as never },
    projectOf: { 'api-1': 'p1', 'folder-1': 'p1', 'rest-1': 'p1' },
    apis: { 'api-1': restApiWire() },
    folders: { 'folder-1': restFolderWire() },
    restRequests: { 'rest-1': restRequestWire({ id: 'rest-1', name: 'Get pet', folderId: 'folder-1' }) },
  });
});

afterEach(() => {
  cleanup();
  registerExplorerTree(null);
});

describe('a request’s path line', () => {
  it('lists the project, the API and the folder, every one of them opening', () => {
    const trail = requestTrail({ apiId: 'api-1', folderId: 'folder-1' }, useProjectStore.getState());
    expect(trail.map((part) => part.text)).toEqual(['Shop', 'Petstore', 'Pets']);
    expect(trail.every((part) => part.open !== undefined)).toBe(true);
  });

  it('opens the API’s tab from its part and reveals its row', async () => {
    render(<RestBreadcrumb requestId="rest-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Petstore' }));

    expect(useEditorsStore.getState().activeId).toBe('api:api-1');
    await vi.waitFor(() => expect(select).toHaveBeenCalledWith('api:api-1', { focus: false }));
    expect(openParents).toHaveBeenCalledWith('api:api-1');
  });

  it('opens the project’s and the folder’s tabs from theirs', () => {
    render(<RestBreadcrumb requestId="rest-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Shop' }));
    expect(useEditorsStore.getState().activeId).toBe('project:p1');
    fireEvent.click(screen.getByRole('button', { name: 'Pets' }));
    expect(useEditorsStore.getState().activeId).toBe('folder:folder-1');
  });
});
