/**
 * The Import dialog's fifth source, offered only for gRPC: a running server asked to describe
 * itself. What matters here is that the tab appears with the format and not otherwise, that the
 * address, version and trust decision reach the channel, and that the summary says the schema was
 * discovered rather than read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';

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

const SUMMARY = {
  name: 'wirebench.greet',
  target: 'localhost:50051',
  files: 3,
  services: 1,
  methods: 6,
  deprecated: 0,
  roots: ['wirebench_greet.proto'],
  kind: 'reflection' as const,
  reflectionVersion: 'v1alpha' as const,
};

function selectGrpc(): void {
  fireEvent.change(screen.getByTestId('import-format-select'), { target: { value: 'proto' } });
}

beforeEach(() => {
  useProjectStore.getState().reset();
  useProjectStore.getState().applySnapshot(project.id, project);
});

afterEach(() => {
  cleanup();
});

describe('importing a gRPC API from a running server', () => {
  it('offers the Server tab only while the format is gRPC', () => {
    installWirebenchApi({ on: vi.fn(() => () => undefined) as unknown as Window['wirebench']['on'] });
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    expect(screen.queryByRole('tab', { name: 'Server' })).toBeNull();
    selectGrpc();
    expect(screen.getByRole('tab', { name: 'Server' })).toBeTruthy();

    fireEvent.change(screen.getByTestId('import-format-select'), { target: { value: 'openapi' } });
    expect(screen.queryByRole('tab', { name: 'Server' })).toBeNull();
  });

  it('sends the address, version and trust decision, and reports the discovery', async () => {
    const importProto = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { projectId: project.id, project, apiId: 'g-1', summary: SUMMARY } });
    installWirebenchApi({
      api: { importProto },
      on: vi.fn(() => () => undefined) as unknown as Window['wirebench']['on'],
    });
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    selectGrpc();
    fireEvent.click(screen.getByRole('tab', { name: 'Server' }));
    fireEvent.change(screen.getByTestId('import-reflection-target'), { target: { value: ' localhost:50051 ' } });
    fireEvent.change(screen.getByTestId('import-reflection-version'), { target: { value: 'v1alpha' } });
    fireEvent.click(screen.getByTestId('import-reflection-trust-invalid'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(importProto).toHaveBeenCalled());
    const call = importProto.mock.calls[0]?.[0] as { source: unknown; grpcTarget: string };
    expect(call.source).toEqual({
      kind: 'reflection',
      target: 'localhost:50051',
      tls: false,
      version: 'v1alpha',
      trustInvalid: true,
    });
    // The API is called at the address it was discovered from unless the user overrode it.
    expect(call.grpcTarget).toBe('localhost:50051');

    const counts = await screen.findByTestId('import-proto-counts');
    expect(counts.textContent).toContain('6 methods');
    expect(screen.getByTestId('import-proto-summary').textContent).toContain('discovered by server reflection');
    expect(screen.getByTestId('import-proto-summary').textContent).toContain('v1alpha');
  });

  it('refuses to start without an address', async () => {
    const importProto = vi.fn();
    installWirebenchApi({
      api: { importProto },
      on: vi.fn(() => () => undefined) as unknown as Window['wirebench']['on'],
    });
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    selectGrpc();
    fireEvent.click(screen.getByRole('tab', { name: 'Server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Enter the server to ask, as host:port')).toBeTruthy();
    expect(importProto).not.toHaveBeenCalled();
  });
});
