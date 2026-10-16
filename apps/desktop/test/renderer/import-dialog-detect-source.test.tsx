import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

type Answer = { ok: true; value: { kind: string; label: string; confidence: string } };
const answer = (kind: string, label: string): Answer => ({ ok: true, value: { kind, label, confidence: 'definite' } });

const detectImportSource = vi.fn();
const openFile = vi.fn();
const openFolder = vi.fn();

beforeEach(() => {
  useProjectStore.getState().reset();
  detectImportSource.mockReset();
  openFile.mockReset();
  openFolder.mockReset();
});

afterEach(() => {
  cleanup();
});

async function openOnFileTab(): Promise<void> {
  installWirebenchApi({ api: { detectImportSource }, dialogs: { openFile, openFolder } });
  render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="auto" />);
  await userEvent.click(screen.getByRole('tab', { name: 'File' }));
}

describe('Import dialog — a picked source detected in main', () => {
  it('asks main about a picked file whose name does not settle it, and shows the answer', async () => {
    detectImportSource.mockResolvedValue(answer('insomnia', 'Insomnia export (v5)'));
    openFile.mockResolvedValue({ ok: true, value: { path: '/work/export.json' } });
    await openOnFileTab();
    fireEvent.click(screen.getByTestId('import-browse'));
    expect((await screen.findByTestId('detected-format-badge')).textContent).toBe('Insomnia export (v5)');
    expect(detectImportSource).toHaveBeenCalledWith({ path: '/work/export.json', folder: false });
  });

  it('asks main about a picked folder instead of assuming a folder collection', async () => {
    detectImportSource.mockResolvedValue(answer('thunder-client', 'Thunder Client collection'));
    openFolder.mockResolvedValue({ ok: true, value: { path: '/work/thunder-tests' } });
    await openOnFileTab();
    fireEvent.click(screen.getByTestId('import-browse-folder'));
    expect(await screen.findByText('Thunder Client collection')).toBeTruthy();
    expect(detectImportSource).toHaveBeenCalledWith({ path: '/work/thunder-tests', folder: true });
    fireEvent.click(screen.getByTestId('import-submit'));
    expect(await screen.findByText(/Thunder Client collection cannot be imported yet/)).toBeTruthy();
  });

  it('drops an answer for a path that has since changed', async () => {
    let first: (value: Answer) => void = () => undefined;
    detectImportSource
      .mockImplementationOnce(() => new Promise<Answer>((resolve) => (first = resolve)))
      .mockResolvedValueOnce(answer('har', 'HAR 1.2'));
    openFile
      .mockResolvedValueOnce({ ok: true, value: { path: '/work/a.json' } })
      .mockResolvedValueOnce({ ok: true, value: { path: '/work/b.json' } });
    await openOnFileTab();
    fireEvent.click(screen.getByTestId('import-browse'));
    await waitFor(() => expect(detectImportSource).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('import-browse'));
    expect((await screen.findByTestId('detected-format-badge')).textContent).toBe('HAR 1.2');
    await act(async () => {
      first(answer('insomnia', 'Insomnia export (v5)'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('detected-format-badge').textContent).toBe('HAR 1.2');
  });

  it('keeps the folder collection reading when main cannot answer', async () => {
    detectImportSource.mockRejectedValue(new Error('no'));
    openFolder.mockResolvedValue({ ok: true, value: { path: '/work/postman' } });
    await openOnFileTab();
    fireEvent.click(screen.getByTestId('import-browse-folder'));
    expect(await screen.findByTestId('import-postman-v3-help')).toBeTruthy();
  });
});
