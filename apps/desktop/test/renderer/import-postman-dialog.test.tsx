import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportPostmanDialog, nameFromSource } from '../../src/renderer/features/explorer/import-postman-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import type { PostmanImportSummaryWire, ProjectWire } from '../../src/shared/wire-types.js';

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

function summary(overrides: Partial<PostmanImportSummaryWire> = {}): PostmanImportSummaryWire {
  return {
    name: 'Sample Collection',
    description: 'A sample collection',
    folders: 2,
    requests: 5,
    auth: 'bearer',
    ...overrides,
  };
}

const importPostman = vi.fn();
const openFile = vi.fn();

function stubWirebench() {
  installWirebenchApi({
    api: { importPostman },
    dialogs: { openFile },
  });
}

function mount(): { onOpenChange: ReturnType<typeof vi.fn> } {
  useProjectStore.setState({
    projects: { 'proj-1': project },
    order: [{ projectId: 'proj-1', interfaceIds: [], apiIds: [] }],
    projectOf: { 'proj-1': 'proj-1' },
  } as never);
  const onOpenChange = vi.fn();
  render(<ImportPostmanDialog open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

beforeEach(() => {
  importPostman.mockReset().mockResolvedValue({
    ok: true,
    value: { apiId: 'api-1', projectId: 'proj-1', project, summary: summary() },
  });
  openFile.mockReset().mockResolvedValue({ ok: true, value: { path: '/picked/collection.json' } });
  useUiStore.setState({ selection: undefined });
  stubWirebench();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('nameFromSource', () => {
  it('extracts collection name from a file path', () => {
    expect(nameFromSource({ kind: 'file', path: '/home/user/my-api.json' })).toBe('my-api');
    expect(nameFromSource({ kind: 'file', path: 'C:\\Users\\test\\collection.v2.json' })).toBe('collection.v2');
  });

  it('falls back to default name for text or undefined', () => {
    expect(nameFromSource(undefined)).toBe('Imported Collection');
    expect(nameFromSource({ kind: 'text', text: '{}' })).toBe('Imported Collection');
  });
});

describe('ImportPostmanDialog', () => {
  it('renders file and paste tabs and form elements', () => {
    mount();
    expect(screen.getByTestId('import-postman-dialog')).toBeTruthy();
    expect(screen.getByText('Import Postman Collection')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'File' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Paste' })).toBeTruthy();
    expect(screen.getByTestId('import-postman-file-input')).toBeTruthy();
    expect(screen.getByTestId('import-postman-browse')).toBeTruthy();
    expect(screen.getByTestId('import-postman-name')).toBeTruthy();
    expect(screen.getByTestId('import-postman-target-project')).toBeTruthy();
    expect(screen.getByTestId('import-postman-base-url')).toBeTruthy();
    expect(screen.getByTestId('import-postman-submit')).toBeTruthy();
  });

  it('shows error if submitted without a source', async () => {
    mount();
    await userEvent.click(screen.getByTestId('import-postman-submit'));
    expect(screen.getByRole('alert').textContent).toContain('Pick a .json file to import');
    expect(importPostman).not.toHaveBeenCalled();
  });

  it('imports a collection from file and displays summary', async () => {
    const { onOpenChange } = mount();

    // Click Browse button
    await userEvent.click(screen.getByTestId('import-postman-browse'));
    expect(openFile).toHaveBeenCalledWith({
      title: 'Import Postman Collection',
      filters: [{ name: 'Postman Collection', extensions: ['json'] }],
    });

    expect(screen.getByTestId<HTMLInputElement>('import-postman-file-input').value).toBe('/picked/collection.json');

    // Submit
    await userEvent.click(screen.getByTestId('import-postman-submit'));

    await waitFor(() => {
      expect(importPostman).toHaveBeenCalledWith({
        target: { projectId: 'proj-1' },
        source: { kind: 'file', path: '/picked/collection.json' },
      });
    });

    // Verify summary screen
    await waitFor(() => {
      expect(screen.getByTestId('import-postman-summary')).toBeTruthy();
    });
    expect(screen.getByText('Sample Collection')).toBeTruthy();
    expect(screen.getByTestId('import-postman-counts').textContent).toContain('5 requests in 2 folders.');
    expect(screen.getByText(/bearer/i)).toBeTruthy();

    // Click Done
    await userEvent.click(screen.getByTestId('import-postman-done'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('imports a collection from pasted text into a new project', async () => {
    mount();

    // Switch to Paste tab
    await userEvent.click(screen.getByRole('tab', { name: 'Paste' }));
    expect(screen.getByTestId('import-postman-paste')).toBeTruthy();

    const jsonText = '{"info": {"name": "Pasted API"}, "item": []}';
    fireEvent.change(screen.getByTestId('import-postman-paste'), { target: { value: jsonText } });

    // Select New Project
    await userEvent.selectOptions(screen.getByTestId('import-postman-target-project'), '');

    // Set custom API name
    await userEvent.type(screen.getByTestId('import-postman-name'), 'Custom Name');

    // Submit
    await userEvent.click(screen.getByTestId('import-postman-submit'));

    await waitFor(() => {
      expect(importPostman).toHaveBeenCalledWith({
        target: { newProjectName: 'Custom Name' },
        source: { kind: 'text', text: jsonText },
        name: 'Custom Name',
      });
    });
  });
});
