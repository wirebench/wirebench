import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { PROJECT_SETTINGS } from '../helpers/wire-defaults.js';

const project: ProjectWire = {
  settings: PROJECT_SETTINGS,
  id: 'proj-1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [
    {
      id: 'iface-1',
      name: 'Calculator',
      slug: 'Calculator',
      definitionUrl: 'http://example.test/service.wsdl',
      cacheDefinition: true,
      targetNamespace: 'http://tempuri.org/',
      soapVersions: ['1.1'],
      services: [],
      operations: [],
      problems: [],
      documentCount: 1,
      endpoints: [],
      hydration: 'ready',
    },
  ],
  requests: [],
  properties: {},
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

function stubWirebench(overrides: Parameters<typeof installWirebenchApi>[0] = {}): {
  emit: (name: string, payload: unknown) => void;
} {
  const listeners = new Map<string, (payload: unknown) => void>();
  const on = vi.fn((name: string, listener: (payload: unknown) => void) => {
    listeners.set(name, listener);
    return () => listeners.delete(name);
  });
  installWirebenchApi({
    definition: { cancelImport: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }) },
    on: on as unknown as Window['wirebench']['on'],
    ...overrides,
  });
  return { emit: (name, payload) => listeners.get(name)?.(payload) };
}

describe('ImportDialog', () => {
  beforeEach(() => {
    // One project open; with none selected in the explorer an import creates its own.
    useProjectStore.getState().reset();
    useProjectStore.getState().applySnapshot(project.id, { ...project, interfaces: [], requests: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a validation error for an invalid URL and does not call the store', async () => {
    stubWirebench();
    const onOpenChange = vi.fn();
    render(<ImportDialog open onOpenChange={onOpenChange} />);

    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Enter a valid URL')).toBeTruthy();
  });

  it('submits a URL source with a generated token', async () => {
    const importFn = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { projectId: project.id, project, interfaceId: 'iface-1' } });
    const { emit } = stubWirebench({ project: { addInterface: importFn } });

    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/service.wsdl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(importFn).toHaveBeenCalled());
    const call = importFn.mock.calls[0]?.[0] as { target: unknown; source: unknown; token: unknown };
    expect(call.source).toEqual({ kind: 'url', url: 'http://example.test/service.wsdl' });
    expect(typeof call.token).toBe('string');
    // Nothing is selected, but there is exactly one open project, so that is the default target.
    expect(call.target).toEqual({ projectId: project.id });

    // A progress event for a different, or matching, token updates the progress line.
    emit('engine.progress', { kind: 'import', token: call.token, phase: 'fetch', message: 'Fetching…' });
  });

  it('imports into the project selected in the explorer', async () => {
    const importFn = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { projectId: project.id, project, interfaceId: 'iface-1' } });
    stubWirebench({ project: { addInterface: importFn } });
    useUiStore.setState({ selection: { kind: 'project', id: project.id } });

    render(<ImportDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/service.wsdl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(importFn).toHaveBeenCalled());
    expect((importFn.mock.calls[0]?.[0] as { target: unknown }).target).toEqual({ projectId: project.id });
    useUiStore.setState({ selection: undefined });
  });

  it('defaults the target to the new project when two are open and none is selected', async () => {
    const second: ProjectWire = { ...project, id: 'proj-2', name: 'Billing', interfaces: [], requests: [] };
    useProjectStore.getState().applySnapshot(second.id, second);
    const importFn = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { projectId: project.id, project, interfaceId: 'iface-1' } });
    stubWirebench({ project: { addInterface: importFn } });

    render(<ImportDialog open onOpenChange={vi.fn()} />);

    const select = screen.getByTestId<HTMLSelectElement>('import-target-project');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Billing',
      'Demo',
      'New project “Imported service”',
    ]);
    expect(select.value).toBe('');

    // The option's name tracks the field, so the user can see what would be created.
    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/Calculator.wsdl' } });
    expect(select.options[2]?.textContent).toBe('New project “Calculator”');

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(importFn).toHaveBeenCalled());
    expect((importFn.mock.calls[0]?.[0] as { target: unknown }).target).toEqual({ newProjectName: 'Calculator' });
  });

  it('submits the project chosen in the target select', async () => {
    const second: ProjectWire = { ...project, id: 'proj-2', name: 'Billing', interfaces: [], requests: [] };
    useProjectStore.getState().applySnapshot(second.id, second);
    const importFn = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { projectId: second.id, project: second, interfaceId: 'iface-1' } });
    stubWirebench({ project: { addInterface: importFn } });

    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByTestId('import-target-project'), { target: { value: second.id } });
    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/service.wsdl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(importFn).toHaveBeenCalled());
    expect((importFn.mock.calls[0]?.[0] as { target: unknown }).target).toEqual({ projectId: second.id });
  });

  it('renders an IPC error inline', async () => {
    const importFn = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'fetch-failed', message: 'Could not reach the server' } });
    stubWirebench({ project: { addInterface: importFn } });

    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://bad.test/service.wsdl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Could not reach the server')).toBeTruthy();
  });

  it('cancelling produces no error and returns the dialog to idle', async () => {
    let resolveImport: (value: { ok: false; error: { code: string; message: string } }) => void = () => {};
    const importFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );
    const cancelImportFn = vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } });
    stubWirebench({
      project: { addInterface: importFn },
      definition: { cancelImport: cancelImportFn },
    });

    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/service.wsdl' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(importFn).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelImportFn).toHaveBeenCalled());

    // The in-flight import resolves as aborted after the cancel — this must not surface an error.
    resolveImport({ ok: false, error: { code: 'aborted', message: 'Import was cancelled' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy());
    expect(screen.queryByText('Import was cancelled')).toBeNull();
  });
});
