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

const importHoppscotch = vi.fn();
const importClientEnvironments = vi.fn();

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  importHoppscotch.mockReset().mockResolvedValue({
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
  installWirebenchApi({ api: { importHoppscotch, importClientEnvironments } });
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — Hoppscotch', () => {
  it('offers File and Paste, and imports a picked collection export into the project', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="hoppscotch" />);
    expect(screen.queryByRole('tab', { name: 'URL' })).toBeNull();
    expect(screen.getByTestId('import-target-project')).toBeTruthy();
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/hoppscotch.json' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importHoppscotch).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/hoppscotch.json' },
      }),
    );
    expect(await screen.findByTestId('import-client-summary')).toBeTruthy();
    expect(screen.getByTestId('import-client-counts').textContent).toBe('1 API, 9 requests, 1 folder');
  });

  it('imports an environments file into the workspace, with no project to pick', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="hoppscotch-environment" />);
    expect(screen.queryByTestId('import-target-project')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: '[{"name":"Staging","variables":[]}]' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importClientEnvironments).toHaveBeenCalledWith({
        format: 'hoppscotch',
        source: { kind: 'text', text: '[{"name":"Staging","variables":[]}]' },
      }),
    );
    expect((await screen.findByTestId('import-variables-summary')).textContent).toContain('Staging');
    expect(importHoppscotch).not.toHaveBeenCalled();
  });
});
