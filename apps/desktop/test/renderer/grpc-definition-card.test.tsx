/**
 * The gRPC API tab's Definition card: an imported API reads its files, a discovered one asks its
 * server again. What the refresh reports back is what the card says changed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GrpcDefinitionCard } from '../../src/renderer/features/grpc-api/grpc-definition-card.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DISCOVERED = {
  kind: 'reflection' as const,
  source: 'localhost:50051',
  cache: true,
  roots: ['wirebench_greet.proto'],
  reflectionVersion: 'v1' as const,
};

describe('GrpcDefinitionCard', () => {
  it('shows the imported-files card for an API built from .proto files', () => {
    installWirebenchApi({});
    render(
      <GrpcDefinitionCard
        apiId="g-1"
        definition={{ kind: 'proto', source: '/protos', cache: true, roots: ['greeter.proto'] }}
      />,
    );
    expect(screen.getByTestId('api-definition-card')).toBeTruthy();
    expect(screen.queryByTestId('grpc-definition-refresh')).toBeNull();
  });

  it('asks the server again with the version the user picked, and says what changed', async () => {
    installWirebenchApi({});
    const refresh = vi.fn().mockResolvedValue({
      summary: { name: 'Greeter', target: 'localhost:50051', methods: 6, services: 1, files: 3, deprecated: 0 },
      requestsAdded: 2,
      requestsOrphaned: 1,
      requestsRestored: 0,
      foldersAdded: 0,
    });
    useProjectStore.setState({ refreshGrpcDefinition: refresh } as never);

    render(<GrpcDefinitionCard apiId="g-1" definition={DISCOVERED} />);
    expect(screen.getByTestId('grpc-definition-version')).toHaveProperty('value', 'v1');

    fireEvent.change(screen.getByTestId('grpc-definition-version'), { target: { value: 'v1alpha' } });
    fireEvent.click(screen.getByTestId('grpc-definition-refresh'));

    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ apiId: 'g-1', version: 'v1alpha' }));
    const changed = await screen.findByTestId('grpc-definition-changed');
    expect(changed.textContent).toBe('Requests: 2 added, 1 orphaned.');
  });

  it('says so plainly when nothing changed', async () => {
    installWirebenchApi({});
    useProjectStore.setState({
      refreshGrpcDefinition: vi.fn().mockResolvedValue({
        summary: { name: 'Greeter', target: 'localhost:50051', methods: 6, services: 1, files: 3, deprecated: 0 },
        requestsAdded: 0,
        requestsOrphaned: 0,
        requestsRestored: 0,
        foldersAdded: 0,
      }),
    } as never);

    render(<GrpcDefinitionCard apiId="g-1" definition={DISCOVERED} />);
    fireEvent.click(screen.getByTestId('grpc-definition-refresh'));

    expect((await screen.findByTestId('grpc-definition-changed')).textContent).toBe('Nothing changed.');
  });

  it('reports a server that could not be asked, and stays usable', async () => {
    installWirebenchApi({});
    useProjectStore.setState({
      refreshGrpcDefinition: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    } as never);

    render(<GrpcDefinitionCard apiId="g-1" definition={DISCOVERED} />);
    fireEvent.click(screen.getByTestId('grpc-definition-refresh'));

    expect((await screen.findByTestId('grpc-definition-error')).textContent).toBe('connect ECONNREFUSED');
    expect(screen.getByTestId('grpc-definition-refresh')).toHaveProperty('disabled', false);
  });
});
