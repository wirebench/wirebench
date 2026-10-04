import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const importPostmanEnvironment = vi.fn();
const importPostmanGlobals = vi.fn();

beforeEach(() => {
  useProjectStore.getState().reset();
  importPostmanEnvironment.mockReset().mockResolvedValue({
    ok: true,
    value: {
      summary: {
        environments: [{ name: 'Staging 2', renamedFrom: 'Staging', variables: 3 }],
        secretsStored: 1,
        warnings: ['Staging 2: the secret "x" had no value in the file; set it in Environments.'],
        notes: ['An environment named "Staging" already exists, so this one was imported as "Staging 2".'],
      },
      reportText: 'Warning: …',
    },
  });
  importPostmanGlobals.mockReset().mockResolvedValue({
    ok: true,
    value: {
      summary: {
        environments: [],
        globals: { added: 2, skipped: ['host'] },
        secretsStored: 0,
        warnings: [],
        notes: [],
      },
      reportText: '',
    },
  });
  installWirebenchApi({ api: { importPostmanEnvironment, importPostmanGlobals } });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — Postman environment', () => {
  it('hides the project picker and shows the report after import', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="postman-environment" />);
    expect(screen.queryByTestId('import-target-project')).toBeNull();
    fireEvent.change(screen.getByTestId('import-file-input'), {
      target: { value: '/work/Staging.postman_environment.json' },
    });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importPostmanEnvironment).toHaveBeenCalledWith({
        source: { kind: 'file', path: '/work/Staging.postman_environment.json' },
      }),
    );
    const summary = await screen.findByTestId('import-variables-summary');
    expect(summary.textContent).toContain('Staging 2 (3 variables)');
    expect(summary.textContent).toContain('was Staging');
    expect(summary.textContent).toContain('1 secret stored');
    expect(screen.getByTestId('import-variables-summary-warnings').textContent).toContain('had no value');
    expect(screen.getByTestId('import-variables-summary-notes').textContent).toContain('Staging 2');
    expect(screen.getByTestId('import-variables-summary-copy-report')).toBeTruthy();
  });

  it('merges pasted globals and lists the names it left alone', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="postman-globals" />);
    expect(screen.queryByTestId('import-target-project')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: '{"values":[]}' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importPostmanGlobals).toHaveBeenCalledWith({ source: { kind: 'text', text: '{"values":[]}' } }),
    );
    const summary = await screen.findByTestId('import-variables-summary');
    expect(summary.textContent).toContain('2 globals added');
    expect(summary.textContent).toContain('host');
  });
});
