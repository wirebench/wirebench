import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const detectImportSource = vi.fn();
const openFile = vi.fn();
const openFolder = vi.fn();

const answer = (kind: string, label: string, confidence = 'definite') => ({
  ok: true,
  value: { kind, label, confidence },
});

async function openFileTab(): Promise<void> {
  installWirebenchApi({ api: { detectImportSource }, dialogs: { openFile, openFolder } });
  render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="auto" />);
  await userEvent.click(screen.getByRole('tab', { name: 'File' }));
}

beforeEach(() => {
  useProjectStore.getState().reset();
  detectImportSource.mockReset();
  openFile.mockReset().mockResolvedValue({ ok: true, value: { path: '/work/export.json' } });
  openFolder.mockReset().mockResolvedValue({ ok: true, value: { path: '/work/bruno-project' } });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog: detection by content in main', () => {
  it('a picked file whose name is not definite asks main and shows the answer', async () => {
    detectImportSource.mockResolvedValue(answer('insomnia', 'Insomnia export'));
    await openFileTab();
    fireEvent.click(screen.getByTestId('import-browse'));
    await waitFor(() => expect(detectImportSource).toHaveBeenCalledWith({ path: '/work/export.json', folder: false }));
    await waitFor(() => expect(screen.getByTestId('detected-format-badge').textContent).toContain('Insomnia export'));
  });

  it('a folder pick asks main instead of assuming postman-v3', async () => {
    detectImportSource.mockResolvedValue(answer('bruno', 'Bruno collection'));
    await openFileTab();
    fireEvent.click(screen.getByTestId('import-browse-folder'));
    await waitFor(() => expect(detectImportSource).toHaveBeenCalledWith({ path: '/work/bruno-project', folder: true }));
    await waitFor(() => expect(screen.getByTestId('detected-format-badge').textContent).toContain('Bruno collection'));
    expect(screen.queryByTestId('import-postman-v3-help')).toBeNull();
  });

  it('a stale answer is dropped', async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    detectImportSource
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(answer('hoppscotch', 'Hoppscotch collection'));
    await openFileTab();
    fireEvent.click(screen.getByTestId('import-browse'));
    await waitFor(() => expect(detectImportSource).toHaveBeenCalledTimes(1));
    openFile.mockResolvedValue({ ok: true, value: { path: '/work/second.json' } });
    fireEvent.click(screen.getByTestId('import-browse'));
    await waitFor(() =>
      expect(screen.getByTestId('detected-format-badge').textContent).toContain('Hoppscotch collection'),
    );
    answerFirst(answer('insomnia', 'Insomnia export'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('detected-format-badge').textContent).toContain('Hoppscotch collection');
    expect(detectImportSource).toHaveBeenCalledTimes(2);
  });
});

describe('Import dialog: a format whose importer is not wired yet', () => {
  it('the format dropdown does not list a client format', () => {
    installWirebenchApi({ api: { detectImportSource }, dialogs: { openFile, openFolder } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="auto" />);
    const values = Array.from(screen.getByTestId('import-format-select').querySelectorAll('option')).map((option) =>
      option.getAttribute('value'),
    );
    expect(values).toContain('openapi');
    expect(values).toContain('insomnia');
    expect(values).toContain('insomnia-environment');
    for (const kind of [
      'bruno',
      'hoppscotch',
      'hoppscotch-environment',
      'thunder-client',
      'thunder-client-environment',
    ]) {
      expect(values).not.toContain(kind);
    }
  });

  it('detecting one says so and keeps Import disabled', async () => {
    detectImportSource.mockResolvedValue(answer('bruno', 'Bruno collection'));
    await openFileTab();
    fireEvent.click(screen.getByTestId('import-browse'));
    await waitFor(() =>
      expect(screen.getByTestId('import-format-unavailable').textContent).toBe(
        'Importing Bruno collection is not available yet.',
      ),
    );
    expect(screen.getByTestId('import-submit')).toHaveProperty('disabled', true);
  });

  it('Enter in the URL field does not import a detected format that is not available', async () => {
    installWirebenchApi({ api: { detectImportSource }, dialogs: { openFile, openFolder } });
    const importDefinition = vi.spyOn(useProjectStore.getState(), 'importDefinition');
    const importOpenApi = vi.spyOn(useProjectStore.getState(), 'importOpenApi');
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="auto" />);
    await userEvent.type(screen.getByTestId('import-url-input'), 'https://example.test/hoppscotch-export.json{Enter}');
    await waitFor(() => expect(screen.getByTestId('import-format-unavailable')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(importDefinition).not.toHaveBeenCalled();
    expect(importOpenApi).not.toHaveBeenCalled();
  });
});
