import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ProjectWire } from '@wirebench/wire/wire-types';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const project: ProjectWire = {
  ...NO_REST,
  settings: PROJECT_SETTINGS,
  id: 'proj-1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  disabledProperties: [],
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

const importPostmanFolder = vi.fn();
const openFolder = vi.fn();

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  importPostmanFolder.mockReset().mockResolvedValue({
    ok: true,
    value: {
      projectId: 'proj-1',
      apiIds: ['a1', 'a2', 'a3'],
      counts: { collections: 2, requests: 16, folders: 2, examples: 2 },
      warnings: ['collections/Realtime/Query.request.yaml: GraphQL requests have no Wirebench equivalent'],
      notes: [],
      reportText: 'Warning: GraphQL',
    },
  });
  openFolder.mockReset().mockResolvedValue({ ok: true, value: { path: '/work/postman' } });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — folder (v3) collections', () => {
  it('detects a folder picked with Folder… and imports it', async () => {
    installWirebenchApi({ api: { importPostmanFolder }, dialogs: { openFolder } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="auto" />);
    await userEvent.click(screen.getByRole('tab', { name: 'File' }));
    fireEvent.click(screen.getByTestId('import-browse-folder'));
    await waitFor(() => expect(screen.getByTestId('import-postman-v3-help')).toBeTruthy());
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importPostmanFolder).toHaveBeenCalledWith({ target: { projectId: 'proj-1' }, path: '/work/postman' }),
    );
    expect((await screen.findByTestId('import-postman-v3-counts')).textContent).toBe(
      '2 collections: 3 APIs, 16 requests, 2 folders',
    );
    expect(screen.getByTestId('import-postman-v3-examples').textContent).toBe('2 examples kept');
  });

  it("detects a typed .resources/definition.yaml and names a new project after the collection's folder", async () => {
    useProjectStore.getState().reset();
    installWirebenchApi({ api: { importPostmanFolder }, dialogs: { openFolder } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="auto" />);
    await userEvent.click(screen.getByRole('tab', { name: 'File' }));
    fireEvent.change(screen.getByTestId('import-file-input'), {
      target: { value: '/work/postman/collections/Books/.resources/definition.yaml' },
    });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importPostmanFolder).toHaveBeenCalledWith({
        target: { newProjectName: 'Books' },
        path: '/work/postman/collections/Books/.resources/definition.yaml',
      }),
    );
  });

  it('asks for the folder when the collection was pasted', async () => {
    installWirebenchApi({ api: { importPostmanFolder }, dialogs: { openFolder } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="postman-v3" />);
    fireEvent.click(screen.getByTestId('import-submit'));
    expect(await screen.findByText('Pick the collection folder with Folder…')).toBeTruthy();
    expect(importPostmanFolder).not.toHaveBeenCalled();
  });
});
