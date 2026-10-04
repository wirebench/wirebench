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

const importHar = vi.fn();

function harResponse(overrides: { historyRecorded?: number; warnings?: string[]; notes?: string[] } = {}) {
  return {
    ok: true,
    value: {
      projectId: 'proj-1',
      project,
      apiIds: ['a1'],
      summary: { entries: 2, kept: 2, requests: 1, apis: 1, statuses: { '200': 2 }, historyRecorded: 0, ...overrides },
      warnings: overrides.warnings ?? [],
      notes: overrides.notes ?? [],
      reportText: '',
    },
  };
}

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  importHar.mockReset().mockResolvedValue(harResponse());
  installWirebenchApi({ api: { importHar } });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — HAR', () => {
  it('asks what to do with recorded responses and passes the choice', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="har" />);
    expect(screen.getByTestId<HTMLInputElement>('import-har-include-static').checked).toBe(false);
    expect(screen.getByTestId<HTMLInputElement>('import-har-responses-drop').checked).toBe(true);
    fireEvent.click(screen.getByTestId('import-har-responses-examples'));
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/session.har' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importHar).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/session.har' },
        includeStaticAssets: false,
        responses: 'examples',
      }),
    );
    const summary = await screen.findByTestId('import-har-summary');
    expect(summary.textContent).toContain('1 API');
    expect(summary.textContent).toContain('1 request');
    expect(summary.textContent).toContain('2 of 2 entries kept');
    expect(summary.textContent).toContain('examples saved');
  });

  it('sends pasted JSON with static assets and History, and shows the report', async () => {
    importHar.mockResolvedValue(
      harResponse({
        historyRecorded: 2,
        warnings: ['GET /pets: the recorded Authorization credential was not imported; set it on the request or API.'],
        notes: ['1 CORS preflight request was skipped.'],
      }),
    );
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="har" />);
    expect(screen.queryByRole('tab', { name: 'URL' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: '{"log":{}}' } });
    fireEvent.click(screen.getByTestId('import-har-include-static'));
    fireEvent.click(screen.getByTestId('import-har-responses-history'));
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importHar).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'text', text: '{"log":{}}' },
        includeStaticAssets: true,
        responses: 'history',
      }),
    );
    const summary = await screen.findByTestId('import-har-summary');
    expect(summary.textContent).toContain('2 History records');
    expect(screen.getByTestId('import-har-summary-warnings').textContent).toContain('Authorization');
    expect(screen.getByTestId('import-har-summary-notes').textContent).toContain('preflight');
    expect(screen.getByTestId('import-har-summary-copy-report')).toBeTruthy();
  });

  it('shows the refusal main answers with', async () => {
    importHar.mockResolvedValue({
      ok: false,
      error: { code: 'har-nothing-to-import', message: 'No HTTP requests were left to import' },
    });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="har" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/empty.har' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    expect((await screen.findByRole('alert')).textContent).toBe('No HTTP requests were left to import');
  });
});
