import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: vi.fn() }));

import { showToast } from '../../src/renderer/components/toast.js';
import {
  CollectionExportReportDialog,
  exportCollection,
  exportReportText,
  useCollectionExportReport,
} from '../../src/renderer/features/explorer/export-collection.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const WRITTEN = {
  cancelled: false,
  dir: '/out',
  files: ['pets.postman_collection.json', 'staging.postman_environment.json'],
  requests: 3,
  warnings: ['Pets gRPC: gRPC requests are not represented by Postman Collection v2.1 and were left out.'],
  notes: ['References to the Env scope are written as plain {{name}} variables.'],
};

afterEach(() => {
  cleanup();
  useCollectionExportReport.setState({ report: null });
  vi.mocked(showToast).mockClear();
});

describe('exportCollection', () => {
  it('asks main for the export and shows the files and the report', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: WRITTEN });
    installWirebenchApi({ workspace: { exportCollection: call } });
    render(<CollectionExportReportDialog />);

    await act(() => exportCollection({ containerId: 'api-1' }, 'postman'));

    expect(call).toHaveBeenCalledWith({ containerId: 'api-1', format: 'postman' });
    expect(screen.getByTestId('collection-export-report').textContent).toContain('Exported as Postman Collection');
    expect(screen.getByTestId('collection-export-files').textContent).toContain('staging.postman_environment.json');
    expect(screen.getByTestId('collection-export-warnings').textContent).toContain('Pets gRPC');
    expect(screen.getByTestId('collection-export-notes').textContent).toContain('Env scope');
  });

  it('says everything was exported when the report is empty', async () => {
    installWirebenchApi({
      workspace: {
        exportCollection: vi.fn().mockResolvedValue({ ok: true, value: { ...WRITTEN, warnings: [], notes: [] } }),
      },
    });
    render(<CollectionExportReportDialog />);
    await act(() => exportCollection({ projectId: 'p1' }, 'opencollection'));
    expect(screen.getByText('Everything was exported.')).toBeTruthy();
  });

  it('does nothing when the folder dialog is cancelled, and toasts a refusal', async () => {
    installWirebenchApi({
      workspace: {
        exportCollection: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            value: { cancelled: true, files: [], requests: 0, warnings: [], notes: [] },
          })
          .mockResolvedValueOnce({
            ok: false,
            error: { code: 'export-nothing', message: 'There is no request to export.' },
          }),
      },
    });
    await exportCollection({ projectId: 'p1' }, 'postman');
    expect(useCollectionExportReport.getState().report).toBeNull();
    await exportCollection({ projectId: 'p1' }, 'postman');
    expect(showToast).toHaveBeenCalledWith('There is no request to export.');
  });

  it('copies the report as text, files first', () => {
    expect(exportReportText({ format: 'postman', ...WRITTEN })).toBe(
      [
        'Exported as Postman Collection to /out:',
        '  pets.postman_collection.json',
        '  staging.postman_environment.json',
        `Warning: ${WRITTEN.warnings[0]!}`,
        `Note: ${WRITTEN.notes[0]!}`,
      ].join('\n'),
    );
  });
});
