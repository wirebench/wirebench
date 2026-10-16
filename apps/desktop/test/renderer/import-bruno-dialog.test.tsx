import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const importBruno = vi.fn();
const importInsomnia = vi.fn();
const detectImportSource = vi.fn();
const openFolder = vi.fn();

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  importInsomnia.mockReset();
  importBruno.mockReset().mockResolvedValue({
    ok: true,
    value: {
      projectId: 'proj-1',
      project,
      apiIds: ['a1', 'a2', 'a3'],
      counts: { collections: 1, requests: 9, folders: 3, examples: 0, assertions: 3, scripts: 4 },
      variables: {
        environments: [
          { name: 'Local', variables: 4 },
          { name: 'Prod', variables: 1 },
        ],
        secretsStored: 0,
        warnings: [],
        notes: [],
      },
      warnings: ['broken.bru, line 7: expected "key: value"; the format has no comments. The file was skipped.'],
      notes: [],
      reportText: 'Warning: …',
    },
  });
  detectImportSource
    .mockReset()
    .mockResolvedValue({ ok: true, value: { kind: 'bruno', label: 'Bruno collection', confidence: 'definite' } });
  openFolder.mockReset().mockResolvedValue({ ok: true, value: { path: '/work/bruno' } });
  installWirebenchApi({ api: { importBruno, importInsomnia, detectImportSource }, dialogs: { openFolder } });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — Bruno', () => {
  it('shows Folder… and File, and imports a picked folder into the project', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="bruno" />);
    expect(screen.queryByRole('tab', { name: 'URL' })).toBeNull();
    expect(screen.getByTestId('import-target-project')).toBeTruthy();
    expect(screen.getByTestId('import-bruno-help').textContent).toContain('.env files are never read');
    fireEvent.click(screen.getByTestId('import-browse-folder'));
    expect(await screen.findByDisplayValue('/work/bruno')).toBeTruthy();
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importBruno).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/bruno' },
      }),
    );
    expect(await screen.findByTestId('import-client-summary')).toBeTruthy();
    expect(screen.getByTestId('import-client-counts').textContent).toBe('3 APIs, 9 requests, 3 folders');
    expect(screen.getByTestId('import-client-report-warnings').textContent).toContain('broken.bru, line 7');
    expect(importInsomnia).not.toHaveBeenCalled();
  });

  it('imports a folder Auto-detect read as Bruno', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="auto" />);
    await userEvent.click(screen.getByRole('tab', { name: 'File' }));
    fireEvent.click(screen.getByTestId('import-browse-folder'));
    await waitFor(() => expect(screen.getByTestId('detected-format-badge').textContent).toBe('Bruno collection'));
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importBruno).toHaveBeenCalledWith(
        expect.objectContaining({ source: { kind: 'file', path: '/work/bruno' } }),
      ),
    );
  });

  it('imports a pasted JSON export', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="bruno" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: '{"version":"1"}' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importBruno).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'text', text: '{"version":"1"}' },
      }),
    );
  });
});
