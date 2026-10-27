import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const importInsomnia = vi.fn();
const importClientEnvironments = vi.fn();

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  importInsomnia.mockReset().mockResolvedValue({
    ok: true,
    value: {
      projectId: 'proj-1',
      project,
      apiIds: ['a1', 'a2', 'a3'],
      counts: { collections: 1, requests: 6, folders: 1, examples: 0, assertions: 0, scripts: 2 },
      variables: {
        environments: [{ name: 'Staging', variables: 2 }],
        secretsStored: 0,
        warnings: [],
        notes: [],
      },
      warnings: ['Vault secret "apiKey" cannot be read from the export: set its value in Environments.'],
      notes: [],
      reportText: 'Warning: …',
    },
  });
  importClientEnvironments.mockReset().mockResolvedValue({
    ok: true,
    value: {
      summary: { environments: [{ name: 'Production', variables: 1 }], secretsStored: 0, warnings: [], notes: [] },
      reportText: '',
    },
  });
  installWirebenchApi({ api: { importInsomnia, importClientEnvironments } });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — Insomnia', () => {
  it('offers File and Paste only, and imports a picked export into the project', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="insomnia" />);
    expect(screen.queryByRole('tab', { name: 'URL' })).toBeNull();
    expect(screen.getByTestId('import-target-project')).toBeTruthy();
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/Insomnia_2026.yaml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importInsomnia).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/Insomnia_2026.yaml' },
      }),
    );
    const summary = await screen.findByTestId('import-client-summary');
    expect(screen.getByTestId('import-client-counts').textContent).toBe('3 APIs, 6 requests, 1 folder');
    expect(screen.getByTestId('import-client-scripts').textContent).toContain('2 script files kept as text');
    expect(summary.textContent).toContain('Staging');
    expect(screen.getByTestId('import-client-report-warnings').textContent).toContain('Vault secret "apiKey"');
  });

  it('imports pasted text', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="insomnia" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: '{"_type":"export"}' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importInsomnia).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'text', text: '{"_type":"export"}' },
      }),
    );
  });

  it('shows a refusal from main as the error', async () => {
    importInsomnia.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'insomnia-environments-only',
        message: 'This Insomnia file holds only environments: import it as Insomnia environments.',
      },
    });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="insomnia" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/envs.yaml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    expect(await screen.findByText(/holds only environments/)).toBeTruthy();
  });

  it('imports an environments file into the workspace, with no project to pick', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="insomnia-environment" />);
    expect(screen.queryByTestId('import-target-project')).toBeNull();
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/envs.yaml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importClientEnvironments).toHaveBeenCalledWith({
        format: 'insomnia',
        source: { kind: 'file', path: '/work/envs.yaml' },
      }),
    );
    expect((await screen.findByTestId('import-variables-summary')).textContent).toContain('Production');
    expect(importInsomnia).not.toHaveBeenCalled();
  });
});
