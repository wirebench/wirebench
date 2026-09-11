import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EndpointsDialog } from '../../src/renderer/features/request-editor/endpoints-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeInterface } from '../mocks/exchange-fixtures.js';

/** Captures every `project.mutate` change the dialog fires. */
function stubMutate(): ReturnType<typeof vi.fn> {
  const mutate = vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      value: {
        project: {
          id: 'p1',
          name: 'P',
          dir: '/tmp/p',
          dirty: false,
          interfaces: [],
          requests: [],
          properties: {},
          environments: [],
          problems: [],
        },
      },
    }),
  );
  installWirebenchApi({ project: { mutate } });
  return mutate;
}

describe('EndpointsDialog', () => {
  beforeEach(() => {
    useProjectStore.setState({ interfaces: { 'if-1': makeInterface() }, projectOf: { 'if-1': 'p1' } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists the interface endpoints and marks the default', () => {
    stubMutate();
    render(<EndpointsDialog open onOpenChange={vi.fn()} interfaceId="if-1" />);

    const rows = screen.getByRole('list', { name: 'Endpoints' }).querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('https://example.test/calc.asmx');
    // The default endpoint's "Set default" button is the disabled one.
    const setDefault = screen.getAllByRole('button', { name: 'Set default' });
    expect(setDefault[0]?.hasAttribute('disabled')).toBe(true);
    expect(setDefault[1]?.hasAttribute('disabled')).toBe(false);
  });

  it('adds an endpoint through add-endpoint', async () => {
    const mutate = stubMutate();
    render(<EndpointsDialog open onOpenChange={vi.fn()} interfaceId="if-1" />);

    await userEvent.type(screen.getByLabelText('New endpoint name'), 'Staging');
    await userEvent.type(screen.getByLabelText('New endpoint URL'), 'https://staging.test/calc.asmx');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: { kind: 'add-endpoint', interfaceId: 'if-1', name: 'Staging', url: 'https://staging.test/calc.asmx' },
    });
  });

  it('edits an endpoint through update-endpoint', async () => {
    const mutate = stubMutate();
    render(<EndpointsDialog open onOpenChange={vi.fn()} interfaceId="if-1" />);

    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    const name = screen.getByLabelText('Endpoint name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Primary');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: {
        kind: 'update-endpoint',
        interfaceId: 'if-1',
        endpointId: 'ep-1',
        patch: { name: 'Primary', url: 'https://example.test/calc.asmx' },
      },
    });
  });

  it('deletes only after the confirmation step', async () => {
    const mutate = stubMutate();
    render(<EndpointsDialog open onOpenChange={vi.fn()} interfaceId="if-1" />);

    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1] as HTMLElement);
    expect(mutate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Confirm delete/ }));
    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: { kind: 'remove-endpoint', interfaceId: 'if-1', endpointId: 'ep-2' },
    });
  });

  it('sets another endpoint as the default', async () => {
    const mutate = stubMutate();
    render(<EndpointsDialog open onOpenChange={vi.fn()} interfaceId="if-1" />);

    await userEvent.click(screen.getAllByRole('button', { name: 'Set default' })[1] as HTMLElement);

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: { kind: 'set-default-endpoint', interfaceId: 'if-1', endpointId: 'ep-2' },
    });
  });
});
