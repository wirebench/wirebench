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

const importOpenCollection = vi.fn();

function openCollectionResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      projectId: 'proj-1',
      project,
      apiIds: ['a1', 'a2'],
      counts: { requests: 5, folders: 1, assertions: 2, assertionsSkipped: 0, scripts: 2 },
      warnings: [],
      notes: [],
      reportText: '',
      ...overrides,
    },
  };
}

/** A single-document collection, as pasted. */
const SINGLE = 'opencollection: "1.0.0"\ninfo:\n  name: Pets\nitems: []\n';

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  importOpenCollection.mockReset().mockResolvedValue(openCollectionResponse());
});

afterEach(() => {
  cleanup();
});

describe('Import dialog — OpenCollection', () => {
  it('explains the directory form and imports the picked root file', async () => {
    installWirebenchApi({ api: { importOpenCollection } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="opencollection" />);
    expect(screen.getByText(/pick its opencollection\.yml/i)).toBeTruthy();
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/pets/opencollection.yml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importOpenCollection).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/pets/opencollection.yml' },
      }),
    );
    expect(await screen.findByTestId('import-opencollection-summary')).toBeTruthy();
  });

  it('names a new project after the folder of a picked opencollection.yml', async () => {
    useProjectStore.getState().reset();
    installWirebenchApi({ api: { importOpenCollection } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="opencollection" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/pets/opencollection.yml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importOpenCollection).toHaveBeenCalledWith({
        target: { newProjectName: 'pets' },
        source: { kind: 'file', path: '/work/pets/opencollection.yml' },
      }),
    );
  });

  it('starts on the File tab and offers no URL tab', () => {
    installWirebenchApi({ api: { importOpenCollection } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="opencollection" />);
    expect(screen.queryByRole('tab', { name: 'URL' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'File' }).getAttribute('aria-selected')).toBe('true');
  });

  it('routes an auto-detected paste to the OpenCollection import', async () => {
    installWirebenchApi({ api: { importOpenCollection } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="auto" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: SINGLE } });
    expect(screen.getByTestId('detected-format-badge').textContent).toContain('OpenCollection');
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() =>
      expect(importOpenCollection).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'text', text: SINGLE },
      }),
    );
    expect(await screen.findByTestId('import-opencollection-summary')).toBeTruthy();
  });

  it('summarises the APIs, counts, assertions, scripts, environments and the report', async () => {
    importOpenCollection.mockResolvedValue(
      openCollectionResponse({
        apiIds: ['a1', 'a2', 'a3'],
        counts: { requests: 5, folders: 1, assertions: 2, assertionsSkipped: 1, scripts: 2 },
        variables: {
          environments: [{ name: 'dev', variables: 3 }],
          projectProperties: { added: 1, skipped: [] },
          secretsStored: 0,
          warnings: [],
          notes: [],
        },
        warnings: ['Dashboard: app items are not supported and were skipped.'],
        notes: ['Get User: the tests script was saved to imported-scripts/pets/get user.tests.js and is never run.'],
        reportText: 'Warning: …',
      }),
    );
    installWirebenchApi({ api: { importOpenCollection } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="opencollection" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/pets.yml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    const summary = await screen.findByTestId('import-opencollection-summary');
    expect(screen.getByTestId('import-opencollection-counts').textContent).toBe('3 APIs, 5 requests, 1 folder');
    expect(screen.getByTestId('import-opencollection-assertions').textContent).toBe('2 assertions mapped, 1 not');
    expect(screen.getByTestId('import-opencollection-scripts').textContent).toBe('2 scripts kept as text, never run');
    expect(summary.textContent).toContain('dev (3 variables)');
    expect(summary.textContent).toContain('1 project property added');
    expect(screen.getByTestId('import-opencollection-summary-warnings').textContent).toContain('app items');
    expect(screen.getByTestId('import-opencollection-summary-notes').textContent).toContain('tests script');
    expect(screen.getByTestId('import-opencollection-summary-copy-report')).toBeTruthy();
  });

  it('summarises a collection that held only environments, without its project snapshot', async () => {
    importOpenCollection.mockResolvedValue({
      ok: true,
      value: {
        projectId: 'proj-1',
        apiIds: [],
        counts: { requests: 0, folders: 0, assertions: 0, assertionsSkipped: 0, scripts: 0 },
        variables: { environments: [{ name: 'dev', variables: 1 }], secretsStored: 1, warnings: [], notes: [] },
        warnings: [],
        notes: [],
        reportText: '',
      },
    });
    installWirebenchApi({ api: { importOpenCollection } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="opencollection" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/envs.yml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    const summary = await screen.findByTestId('import-opencollection-summary');
    expect(screen.getByTestId('import-opencollection-counts').textContent).toBe('0 APIs, 0 requests, 0 folders');
    expect(screen.queryByTestId('import-opencollection-assertions')).toBeNull();
    expect(summary.textContent).toContain('dev (1 variable)');
    expect(summary.textContent).toContain('1 secret stored');
  });

  it('shows the refusal main answers with', async () => {
    importOpenCollection.mockResolvedValue({
      ok: false,
      error: {
        code: 'oc-nothing-to-import',
        message: 'The OpenCollection has no requests and no environments to import.',
      },
    });
    installWirebenchApi({ api: { importOpenCollection } });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="opencollection" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/empty.yml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The OpenCollection has no requests and no environments to import.',
    );
  });
});
