/**
 * The gRPC request editor.
 *
 * What a user would notice going wrong: the method picker is built from the API's definition and a
 * choice stages the method (and fills a blank message with the sample) rather than writing; an edit
 * to the message is staged; Send names only the request and its draft; the strip says where the call
 * resolves to; and an API with no definition still lets the method be typed by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { GrpcEditor, isBlankMessage } from '../../src/renderer/features/grpc-editor/grpc-editor.js';
import { findMethod, methodOptionValue } from '../../src/renderer/features/grpc-editor/call-bar.js';
import { methodKindLabel } from '../../src/renderer/features/grpc-editor/method-kind-badge.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { grpcApiWire, grpcRequestWire, restFolderWire } from '../helpers/wire-defaults.js';
import { makeGrpcExchange } from '../mocks/exchange-fixtures.js';
import type { GrpcServiceDescriptorWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const sendGrpc = vi.fn();
const preflightGrpc = vi.fn();
const cancel = vi.fn();
const grpcDefinition = vi.fn();
const grpcSample = vi.fn();

const GREETER: GrpcServiceDescriptorWire = {
  name: 'Greeter',
  fullName: 'wirebench.greet.Greeter',
  package: 'wirebench.greet',
  methods: [
    {
      name: 'SayHello',
      service: 'wirebench.greet.Greeter',
      kind: 'unary',
      requestType: 'wirebench.greet.HelloRequest',
      responseType: 'wirebench.greet.HelloReply',
    },
    {
      name: 'LotsOfReplies',
      service: 'wirebench.greet.Greeter',
      kind: 'server-streaming',
      requestType: 'wirebench.greet.StreamRequest',
      responseType: 'wirebench.greet.HelloReply',
    },
  ],
};

function seed(
  request = grpcRequestWire({ service: 'wirebench.greet.Greeter', method: 'SayHello', message: '{"name":"Ada"}' }),
  api = grpcApiWire({
    tls: true,
    definition: { kind: 'proto', source: '/protos/greeter.proto', cache: true, roots: ['greeter.proto'] },
  }),
): void {
  const folder = restFolderWire({ id: 'folder-g', apiId: api.id, name: 'Greetings' });
  useProjectStore.setState({
    grpcApis: { [api.id]: api },
    folders: { [folder.id]: folder },
    grpcRequests: { [request.id]: request },
    grpc: { p1: { apis: [api], requests: [request] } },
    rest: { p1: { apis: [], folders: [folder], requests: [] } },
    projects: {},
    projectOf: { [api.id]: 'p1', [folder.id]: 'p1', [request.id]: 'p1' },
  });
}

function mount(requestId = 'grpc-1'): void {
  render(
    <TooltipPrimitive.Provider>
      <GrpcEditor requestId={requestId} />
    </TooltipPrimitive.Provider>,
  );
}

function staged(requestId = 'grpc-1'): Record<string, unknown> | undefined {
  return useDraftsStore.getState().peekGrpcRequest(requestId);
}

describe('GrpcEditor', () => {
  beforeEach(() => {
    sendGrpc.mockReset().mockResolvedValue({ ok: true, value: makeGrpcExchange() });
    cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
    preflightGrpc.mockReset().mockResolvedValue({
      ok: true,
      value: {
        endpoint: 'greeter.test:443',
        endpointSource: 'environment',
        unresolved: [],
        auth: { type: 'none', source: 'none' },
        wsa: { enabled: false },
      },
    });
    grpcDefinition.mockReset().mockResolvedValue({
      ok: true,
      value: { services: [GREETER], files: [], source: '/protos/greeter.proto', fetchedAt: 'now', roots: [] },
    });
    grpcSample
      .mockReset()
      .mockImplementation((input: { type: string }) =>
        Promise.resolve({ ok: true, value: { text: `{"sample":"${input.type}"}` } }),
      );
    installWirebenchApi({
      request: { sendGrpc, preflightGrpc, cancel },
      api: { grpcDefinition, grpcSample },
    });
    useDraftsStore.getState().reset();
    useEditorsStore.getState().reset();
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, log: [] });
    seed();
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('shows the path, offers the definition’s methods and names the resolved target', async () => {
    mount();

    expect(screen.getByTestId('grpc-editor')).toBeTruthy();
    expect(screen.getByTestId('grpc-breadcrumb').textContent).toContain('Greeter');
    const select = await screen.findByTestId<HTMLSelectElement>('grpc-method');
    expect(select.value).toBe('wirebench.greet.Greeter/SayHello');
    expect([...select.options].map((option) => option.value)).toContain('wirebench.greet.Greeter/LotsOfReplies');
    await waitFor(() => {
      expect(screen.getByTestId('grpc-target').textContent).toBe('grpcs://greeter.test:443');
    });
    expect(grpcDefinition).toHaveBeenCalledWith({ apiId: 'grpc-api-1' });
  });

  it('stages a method change and keeps a message the user typed', async () => {
    mount();
    const select = await screen.findByTestId<HTMLSelectElement>('grpc-method');

    fireEvent.change(select, { target: { value: 'wirebench.greet.Greeter/LotsOfReplies' } });

    expect(staged()).toEqual({
      service: 'wirebench.greet.Greeter',
      method: 'LotsOfReplies',
      methodKind: 'server-streaming',
    });
    expect(grpcSample).not.toHaveBeenCalled();
    expect(useDraftsStore.getState().isGrpcRequestDirty('grpc-1')).toBe(true);
  });

  it('fills a blank message with the chosen method’s sample', async () => {
    seed(grpcRequestWire({ service: '', method: '', message: '{}' }));
    mount();
    const select = await screen.findByTestId<HTMLSelectElement>('grpc-method');

    fireEvent.change(select, { target: { value: 'wirebench.greet.Greeter/SayHello' } });

    await waitFor(() => {
      expect(staged()?.['message']).toBe('{"sample":"wirebench.greet.HelloRequest"}');
    });
    expect(grpcSample).toHaveBeenCalledWith({ apiId: 'grpc-api-1', type: 'wirebench.greet.HelloRequest' });
  });

  it('resets the message to the sample on request', async () => {
    mount();
    await screen.findByTestId('grpc-method');

    fireEvent.click(await screen.findByTestId('grpc-message-sample'));

    await waitFor(() => {
      expect(staged()?.['message']).toBe('{"sample":"wirebench.greet.HelloRequest"}');
    });
  });

  it('sends by request id and draft only, then shows the reply', async () => {
    mount();
    await screen.findByTestId('grpc-method');
    useDraftsStore.getState().stageGrpcRequest('grpc-1', { message: '{"name":"Grace"}' });

    fireEvent.click(screen.getByTestId('grpc-send'));

    await waitFor(() => {
      expect(sendGrpc).toHaveBeenCalledTimes(1);
    });
    const payload = sendGrpc.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['draft', 'requestId', 'sendId']);
    expect(payload['requestId']).toBe('grpc-1');
    await waitFor(() => {
      expect(screen.getByTestId('grpc-response-status').textContent).toContain('OK (0)');
    });
    expect(screen.getAllByTestId('grpc-response-message')).toHaveLength(1);
  });

  it('lets the service and method be typed when the API has no definition', async () => {
    grpcDefinition.mockResolvedValue({ ok: false, error: { code: 'grpc-no-definition', message: 'none' } });
    seed(grpcRequestWire({ service: '', method: '' }), grpcApiWire());
    mount();

    const service = await screen.findByTestId<HTMLInputElement>('grpc-service');
    fireEvent.change(service, { target: { value: 'a.B' } });
    expect(staged()).toEqual({ service: 'a.B', method: '' });
    fireEvent.change(screen.getByTestId('grpc-method-name'), { target: { value: 'Call' } });
    expect(staged()).toEqual({ service: 'a.B', method: 'Call' });
  });

  it('says so when the request is gone', () => {
    mount('missing');
    expect(screen.getByText('This request no longer exists.')).toBeTruthy();
  });
});

describe('call bar helpers', () => {
  it('spells a method as its path and finds it back', () => {
    const method = GREETER.methods[0]!;
    expect(methodOptionValue(method)).toBe('wirebench.greet.Greeter/SayHello');
    expect(findMethod([GREETER], 'wirebench.greet.Greeter/SayHello')).toBe(method);
    expect(findMethod([GREETER], 'wirebench.greet.Greeter/Nope')).toBeUndefined();
  });

  it('treats an empty object as a blank message, and anything typed as not', () => {
    expect(isBlankMessage('')).toBe(true);
    expect(isBlankMessage('  {}\n')).toBe(true);
    expect(isBlankMessage('{"a":1}')).toBe(false);
  });

  it('labels every streaming shape, in full and in short', () => {
    expect(methodKindLabel('unary')).toBe('Unary');
    expect(methodKindLabel('bidi-streaming')).toBe('Bidirectional streaming');
    expect(methodKindLabel('server-streaming', true)).toBe('RPC↓');
    expect(methodKindLabel('client-streaming', true)).toBe('RPC↑');
  });
});
