import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportCurlFromTarget } from '../../src/renderer/features/request-editor/import-curl-from-target.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const importCurl = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
vi.mock('../../src/renderer/features/request-editor/request-actions.js', async (original) => ({
  ...(await original<object>()),
  importCurl,
}));

describe('Import cURL into a provisional API', () => {
  const removeApi = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    installWirebenchApi();
    importCurl.mockReset();
    removeApi.mockClear();
    useProjectStore.setState({ removeApi });
    useUiStore.getState().setImportCurlTarget({ kind: 'rest', apiId: 'api-1' }, { provisional: true });
  });

  afterEach(() => {
    cleanup();
    useUiStore.getState().setImportCurlTarget(undefined);
  });

  it('removes the API it was made for when the dialog is cancelled', async () => {
    render(<ImportCurlFromTarget />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removeApi).toHaveBeenCalledWith('api-1');
    expect(useUiStore.getState().importCurlTarget).toBeUndefined();
    expect(useUiStore.getState().importCurlProvisionalApiId).toBeUndefined();
  });

  it('keeps the API once a request is imported into it', async () => {
    importCurl.mockResolvedValue('req-1');
    render(<ImportCurlFromTarget />);
    await userEvent.type(screen.getByLabelText('cURL command'), 'curl https://example.test/pets');
    await userEvent.click(screen.getByTestId('import-curl-submit'));
    await waitFor(() => {
      expect(useUiStore.getState().importCurlTarget).toBeUndefined();
    });
    expect(removeApi).not.toHaveBeenCalled();
  });

  it('removes it when the import fails', async () => {
    importCurl.mockResolvedValue(undefined);
    render(<ImportCurlFromTarget />);
    await userEvent.type(screen.getByLabelText('cURL command'), 'curl https://example.test/pets');
    await userEvent.click(screen.getByTestId('import-curl-submit'));
    await waitFor(() => {
      expect(removeApi).toHaveBeenCalledWith('api-1');
    });
  });

  it('never removes an API the dialog was simply pointed at', async () => {
    useUiStore.getState().setImportCurlTarget({ kind: 'rest', apiId: 'api-1' });
    render(<ImportCurlFromTarget />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removeApi).not.toHaveBeenCalled();
  });
});
