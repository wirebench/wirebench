/**
 * The gRPC third of the exchanges store.
 *
 * The same promise the REST half makes: the renderer names the request and hands over its unsaved
 * draft, and nothing else — no target, no credential — because main owns the environment, the model
 * and the keychain. A non-OK gRPC status is a *result*, kept under the request like any reply, not
 * an error state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeGrpcExchange } from '../mocks/exchange-fixtures.js';
import { grpcApiWire, grpcRequestWire } from '../helpers/wire-defaults.js';

const sendGrpc = vi.fn();
const cancel = vi.fn();

beforeEach(() => {
  sendGrpc.mockReset().mockResolvedValue({ ok: true, value: makeGrpcExchange() });
  cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  installWirebenchApi({ request: { sendGrpc, cancel } });
  useExchangesStore.setState({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, log: [] });
  useDraftsStore.getState().reset();
  useProblemsStore.setState({ items: [] });
  useProjectStore.setState({
    grpcApis: { 'grpc-api-1': grpcApiWire() },
    grpcRequests: { 'grpc-1': grpcRequestWire() },
    projectOf: { 'grpc-api-1': 'p1', 'grpc-1': 'p1' },
  });
});

describe('sendGrpc', () => {
  it('names the request only, and keeps the reply under that request', async () => {
    await useExchangesStore.getState().sendGrpc('grpc-1');

    expect(sendGrpc).toHaveBeenCalledTimes(1);
    const payload = sendGrpc.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['requestId', 'sendId']);
    expect(useExchangesStore.getState().grpcByRequest['grpc-1']).toMatchObject({ status: 'done' });
    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.exchange?.statusName).toBe('OK');
  });

  it('hands over the unsaved draft, so the send is what the editor is showing', async () => {
    useDraftsStore.getState().stageGrpcRequest('grpc-1', { message: '{"name":"Grace"}' });

    await useExchangesStore.getState().sendGrpc('grpc-1');

    expect(sendGrpc.mock.calls[0]?.[0]).toMatchObject({ draft: { message: '{"name":"Grace"}' } });
  });

  it('keeps a non-OK status as a result, not an error', async () => {
    sendGrpc.mockResolvedValue({
      ok: true,
      value: makeGrpcExchange({
        status: 5,
        statusName: 'NOT_FOUND',
        statusMessage: 'no such user',
        responseMessages: [],
      }),
    });

    await useExchangesStore.getState().sendGrpc('grpc-1');

    const state = useExchangesStore.getState().grpcByRequest['grpc-1'];
    expect(state?.status).toBe('done');
    expect(state?.exchange?.statusName).toBe('NOT_FOUND');
    expect(useProblemsStore.getState().items).toEqual([]);
  });

  it('leaves the other two protocols untouched, and joins the shared HTTP log', async () => {
    await useExchangesStore.getState().sendGrpc('grpc-1');

    expect(useExchangesStore.getState().byRequest).toEqual({});
    expect(useExchangesStore.getState().restByRequest).toEqual({});
    expect(useExchangesStore.getState().log).toHaveLength(1);
    const entry = useExchangesStore.getState().log[0];
    expect(entry?.kind).toBe('exchange');
    expect(
      entry?.kind === 'exchange' && !('protocol' in entry.exchange) ? entry.exchange.http.httpVersion : undefined,
    ).toBe('2');
  });

  it('records a transport failure as an error state and a Problems entry', async () => {
    sendGrpc.mockResolvedValue({ ok: false, error: { code: 'connection-refused', message: 'ECONNREFUSED' } });

    await useExchangesStore.getState().sendGrpc('grpc-1');

    expect(useExchangesStore.getState().grpcByRequest['grpc-1']).toMatchObject({
      status: 'error',
      error: { code: 'connection-refused' },
    });
    expect(useExchangesStore.getState().log).toEqual([]);
    expect(useProblemsStore.getState().items).toHaveLength(1);
  });

  it('cancels by the send id it started, and does nothing with no send in flight', async () => {
    await useExchangesStore.getState().cancelGrpc('grpc-1');
    expect(cancel).not.toHaveBeenCalled();

    sendGrpc.mockImplementation(async () => {
      const sendId = useExchangesStore.getState().grpcByRequest['grpc-1']?.sendId;
      await useExchangesStore.getState().cancelGrpc('grpc-1');
      expect(cancel).toHaveBeenCalledWith({ sendId });
      return { ok: false, error: { code: 'aborted', message: 'cancelled' } };
    });
    await useExchangesStore.getState().sendGrpc('grpc-1');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown request without calling main', async () => {
    await useExchangesStore.getState().sendGrpc('nope');

    expect(sendGrpc).not.toHaveBeenCalled();
    expect(useExchangesStore.getState().grpcByRequest['nope']?.status).toBe('error');
  });
});

describe('the gRPC save path', () => {
  it('stages an edit into the mirror and the drafts store, writing nothing', () => {
    const mutate = vi.fn();
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().editGrpcRequest('grpc-1', { message: '{"name":"Ada"}' });

    expect(useProjectStore.getState().grpcRequests['grpc-1']?.message).toBe('{"name":"Ada"}');
    expect(useDraftsStore.getState().peekGrpcRequest('grpc-1')).toEqual({ message: '{"name":"Ada"}' });
    expect(useDraftsStore.getState().isGrpcRequestDirty('grpc-1')).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('commits the staged patch as one mutation and clears the draft', async () => {
    const mutate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        project: {
          id: 'p1',
          name: 'Demo',
          dir: '/tmp/p',
          dirty: true,
          interfaces: [],
          requests: [],
          apis: [],
          folders: [],
          restRequests: [],
          grpcApis: [grpcApiWire()],
          grpcRequests: [grpcRequestWire({ message: '{"name":"Ada"}' })],
          properties: {},
          disabledProperties: [],
          environments: [],
          problems: [],
          settings: { cacheDefinitions: true, defaultTimeoutMs: 1000, prettyPrintResponses: true },
          keystores: [],
          wssOutgoing: [],
          wssIncoming: [],
        },
      },
    });
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().editGrpcRequest('grpc-1', { message: '{"name":"Ada"}' });
    await expect(useProjectStore.getState().commitGrpcRequest('grpc-1')).resolves.toBe(true);

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: { kind: 'update-grpc-request', requestId: 'grpc-1', patch: { message: '{"name":"Ada"}' } },
    });
    expect(useDraftsStore.getState().isGrpcRequestDirty('grpc-1')).toBe(false);
  });
});
