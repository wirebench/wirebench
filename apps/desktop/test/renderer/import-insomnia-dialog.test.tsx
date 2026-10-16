import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const importInsomnia = vi.fn();
const importClientEnvironments = vi.fn();

const VAULT_WARNING =
  'Vault secrets cannot be read from an export: svcPassword (Staging). Each was imported as a secret with no value; set it in Environments.';

beforeEach(() => {
  useProjectStore.getState().reset();
  importInsomnia.mockReset().mockResolvedValue({
    ok: true,
    value: {
      projectId: 'p-new',
      apiIds: ['a1'],
      counts: { collections: 1, requests: 4, folders: 2, examples: 0, assertions: 0, scripts: 1 },
      warnings: [VAULT_WARNING],
      notes: [],
      reportText: `Warning: ${VAULT_WARNING}`,
    },
  });
  importClientEnvironments.mockReset().mockResolvedValue({
    ok: true,
    value: {
      summary: {
        environments: [{ name: 'Staging', variables: 2 }],
        secretsStored: 0,
        warnings: [VAULT_WARNING],
        notes: [],
      },
      reportText: '',
    },
  });
  installWirebenchApi({ api: { importInsomnia, importClientEnvironments } });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog: Insomnia', () => {
  it('the Insomnia row shows File and Paste and the picker', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="insomnia" />);
    expect(screen.getByRole('tab', { name: 'File' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Paste' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'URL' })).toBeNull();
    expect(screen.getByTestId('import-target-project')).toBeTruthy();

    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/Insomnia_2026.yaml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importInsomnia).toHaveBeenCalledWith({
        target: { newProjectName: 'Insomnia_2026' },
        source: { kind: 'file', path: '/work/Insomnia_2026.yaml' },
      }),
    );
  });

  it('the report lists vault secrets needing values', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="insomnia" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: '{"_type":"export"}' } });
    fireEvent.click(screen.getByTestId('import-submit'));

    const summary = await screen.findByTestId('import-client-summary');
    expect(summary.textContent).toContain('4 requests');
    expect(screen.getByTestId('import-client-report-warnings').textContent).toContain('svcPassword (Staging)');
    expect(importInsomnia).toHaveBeenCalledWith({
      target: { newProjectName: 'Imported collection' },
      source: { kind: 'text', text: '{"_type":"export"}' },
    });
  });

  it('the environment row hides the picker', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="insomnia-environment" />);
    expect(screen.queryByTestId('import-target-project')).toBeNull();
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/env.yaml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importClientEnvironments).toHaveBeenCalledWith({
        format: 'insomnia',
        source: { kind: 'file', path: '/work/env.yaml' },
      }),
    );
    const summary = await screen.findByTestId('import-variables-summary');
    expect(summary.textContent).toContain('Staging (2 variables)');
  });
});
