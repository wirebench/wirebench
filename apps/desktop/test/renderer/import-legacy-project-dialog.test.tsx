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

const report = {
  projectName: 'Billing Suite',
  counts: { interfaces: 2, operations: 4, requests: 6, environments: 2, properties: 3, scripts: 5 },
  items: [
    { severity: 'warning' as const, path: 'EchoBinding › Echo › Staging', message: 'The password was not imported.' },
    { severity: 'info' as const, path: '', message: 'A script (afterLoadScript) was saved.' },
  ],
};

const importLegacy = vi.fn();
const writeText = vi.fn();

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
  importLegacy.mockReset().mockResolvedValue({
    ok: true,
    value: { projectId: 'proj-1', project, report, reportText: 'Imported "Billing Suite": …' },
  });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  installWirebenchApi({ project: { importLegacy } });
});

afterEach(() => {
  cleanup();
});

describe('ImportDialog: legacy SOAP project', () => {
  it('imports the picked file into the open project and shows what came across', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="legacy-soap-project" />);
    expect(screen.getByText('Import Legacy SOAP Project')).toBeTruthy();

    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/billing-project.xml' } });
    fireEvent.click(screen.getByTestId('import-submit'));

    await waitFor(() => {
      expect(importLegacy).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/work/billing-project.xml' },
        token: expect.any(String) as string,
      });
    });
    expect(await screen.findByTestId('import-legacy-summary')).toBeTruthy();
    expect(screen.getByTestId('import-legacy-counts').textContent).toBe(
      '2 interfaces, 6 requests in 4 operations, 2 environments, 3 properties, 5 scripts kept in imported-scripts/.',
    );
    expect(screen.getByTestId('import-legacy-warnings').textContent).toContain('The password was not imported.');
    expect(screen.getByTestId('import-legacy-notes').textContent).toContain('A script (afterLoadScript) was saved.');

    fireEvent.click(screen.getByTestId('import-legacy-copy-report'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Imported "Billing Suite": …'));
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('asks main to name a new project after the file unless a name is typed', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="legacy-soap-project" />);
    fireEvent.change(screen.getByTestId('import-target-project'), { target: { value: '' } });
    expect(screen.getByRole('option', { name: 'New project, named as in the file' })).toBeTruthy();

    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/p.xml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() => {
      expect(importLegacy).toHaveBeenCalledWith(expect.objectContaining({ target: { newProjectName: '' } }));
    });
  });

  it('refuses a pasted document: the project is read from its file', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="legacy-soap-project" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    fireEvent.change(screen.getByTestId('import-paste'), { target: { value: '<x/>' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    expect((await screen.findByRole('alert')).textContent).toContain('Choose the project file with Browse');
    expect(importLegacy).not.toHaveBeenCalled();
  });

  it('shows main’s error when the file is not a legacy project', async () => {
    importLegacy.mockResolvedValue({
      ok: false,
      error: { code: 'legacy-not-a-project', message: 'The file is not a legacy SOAP project' },
    });
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="legacy-soap-project" />);
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/other.xml' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    expect((await screen.findByRole('alert')).textContent).toBe('The file is not a legacy SOAP project');
  });
});
