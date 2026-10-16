import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
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

const importThunderClient = vi.fn();
const importClientEnvironments = vi.fn();
const detectImportSource = vi.fn();
const openFolder = vi.fn();

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  importThunderClient.mockReset().mockResolvedValue({
    ok: true,
    value: {
      projectId: 'proj-1',
      project,
      apiIds: ['a1'],
      counts: { collections: 1, requests: 9, folders: 1, examples: 1, assertions: 0, scripts: 4 },
      warnings: [],
      notes: [],
      reportText: '',
    },
  });
  importClientEnvironments.mockReset().mockResolvedValue({
    ok: true,
    value: {
      summary: { environments: [{ name: 'Staging', variables: 3 }], secretsStored: 0, warnings: [], notes: [] },
      reportText: '',
    },
  });
  detectImportSource.mockReset().mockResolvedValue({
    ok: true,
    value: { kind: 'thunder-client', label: 'Thunder Client collection', confidence: 'definite' },
  });
  openFolder.mockReset();
  installWirebenchApi({
    api: { importThunderClient, importClientEnvironments, detectImportSource },
    dialogs: { openFolder },
  });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — Thunder Client', () => {
  it('offers File and Paste, and imports a picked collection export into the project', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="thunder-client" />);
    expect(screen.queryByRole('tab', { name: 'URL' })).toBeNull();
    expect(screen.getByTestId('import-target-project')).toBeTruthy();
    fireEvent.change(screen.getByTestId('import-file-input'), {
      target: { value: '/work/thunder-collection_shop.json' },
    });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importThunderClient).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/thunder-collection_shop.json' },
      }),
    );
    expect(await screen.findByTestId('import-client-summary')).toBeTruthy();
    expect(screen.getByTestId('import-client-counts').textContent).toBe('1 API, 9 requests, 1 folder');
  });

  it('imports a thunder-tests folder picked with Folder…', async () => {
    openFolder.mockResolvedValue({ ok: true, value: { path: '/work/thunder-tests' } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="thunder-client" />);
    expect(screen.getByTestId('import-thunder-client-help')).toBeTruthy();
    fireEvent.click(screen.getByTestId('import-browse-folder'));
    await waitFor(() => expect(openFolder).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importThunderClient).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/thunder-tests' },
      }),
    );
  });

  it('imports an environments file into the workspace, with no project to pick', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="thunder-client-environment" />);
    expect(screen.queryByTestId('import-target-project')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), {
      target: { value: '{"clientName":"Thunder Client","environmentName":"Staging","variables":[]}' },
    });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importClientEnvironments).toHaveBeenCalledWith({
        format: 'thunder-client',
        source: { kind: 'text', text: '{"clientName":"Thunder Client","environmentName":"Staging","variables":[]}' },
      }),
    );
    expect((await screen.findByTestId('import-variables-summary')).textContent).toContain('Staging');
    expect(importThunderClient).not.toHaveBeenCalled();
  });
});
