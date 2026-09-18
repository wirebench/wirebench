/**
 * The running half of a gRPC call in the exchanges store: `grpc.live` events folded into the
 * request they belong to, and the interactive pushes that drive a call whose request side is open.
 *
 * The events arrive keyed by `sendId` alone, so the correlation *is* the guard: an event for a send
 * this request has already replaced, or for one that has finished, must land nowhere. Both of those
 * are asserted here, since neither shows up as a type error and both would corrupt a pane.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { GrpcLiveEvent, GrpcResponseMessageWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeGrpcExchange } from '../mocks/exchange-fixtures.js';
import { grpcApiWire, grpcRequestWire } from '../helpers/wire-defaults.js';

const sendGrpc = vi.fn();
const grpcPush = vi.fn();
const grpcHalfClose = vi.fn();
const cancel = vi.fn();

/** One decoded response message, as main puts it on the wire. */
function message(json: string): GrpcResponseMessageWire {
  return { json, base64: Buffer.from(json).toString('base64'), bytes: json.length };
}

/** The send id the store generated for the call in flight. */
function sendIdOf(requestId = 'grpc-1'): string {
  const id = useExchangesStore.getState().grpcByRequest[requestId]?.sendId;
  expect(id).toBeDefined();
  return id!;
}

function live(event: GrpcLiveEvent): void {
  useExchangesStore.getState().applyGrpcLive(event);
}

beforeEach(() => {
  sendGrpc.mockReset();
  grpcPush.mockReset().mockResolvedValue({ ok: true, value: { json: '{\n  "name": "Ada"\n}' } });
  grpcHalfClose.mockReset().mockResolvedValue({ ok: true, value: { closed: true } });
  cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  installWirebenchApi({ request: { sendGrpc, cancel, grpcPush, grpcHalfClose } });
  useExchangesStore.setState({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, log: [] });
  useDraftsStore.getState().reset();
  useProblemsStore.setState({ items: [] });
  useProjectStore.setState({
    grpcApis: { 'grpc-api-1': grpcApiWire() },
    grpcRequests: { 'grpc-1': grpcRequestWire() },
    projectOf: { 'grpc-api-1': 'p1', 'grpc-1': 'p1' },
  });
});

/** Starts a send that never resolves, so the test can drive the call while it is "in flight". */
function startSend(options?: { readonly interactive?: boolean }): Promise<void> {
  sendGrpc.mockReturnValue(new Promise(() => undefined));
  return useExchangesStore.getState().sendGrpc('grpc-1', options);
}

describe('applyGrpcLive', () => {
  it('appends each message to the call it belongs to, in arrival order', () => {
    void startSend();
    const sendId = sendIdOf();

    live({ kind: 'headers', sendId, httpStatus: 200, headers: { 'content-type': 'application/grpc' } });
    live({ kind: 'message', sendId, index: 0, message: message('{"message":"Hello #1"}') });
    live({ kind: 'message', sendId, index: 1, message: message('{"message":"Hello #2"}') });

    const state = useExchangesStore.getState().grpcByRequest['grpc-1'];
    expect(state?.status).toBe('sending');
    expect(state?.live?.headers).toEqual({ 'content-type': 'application/grpc' });
    expect(state?.live?.messages.map((one) => one.json)).toEqual(['{"message":"Hello #1"}', '{"message":"Hello #2"}']);
  });

  it('marks the request side open and closed', () => {
    void startSend({ interactive: true });
    const sendId = sendIdOf();
    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.live?.open).toBe(false);

    live({ kind: 'open', sendId });
    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.live?.open).toBe(true);

    live({ kind: 'closed', sendId });
    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.live?.open).toBe(false);
  });

  it('drops an event for a send this request has already replaced', () => {
    void startSend();
    const first = sendIdOf();
    // A second send supersedes the first; the first call's messages must not reach the new pane.
    void startSend();
    const second = sendIdOf();
    expect(second).not.toBe(first);

    live({ kind: 'message', sendId: first, index: 0, message: message('{"stale":true}') });

    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.live?.messages).toEqual([]);
  });

  it('drops an event that arrives after the call has finished', async () => {
    sendGrpc.mockResolvedValue({ ok: true, value: makeGrpcExchange({ sendId: 'finished' }) });
    await useExchangesStore.getState().sendGrpc('grpc-1');
    const state = useExchangesStore.getState().grpcByRequest['grpc-1'];
    expect(state?.status).toBe('done');

    live({ kind: 'message', sendId: state!.sendId!, index: 0, message: message('{"late":true}') });

    const after = useExchangesStore.getState().grpcByRequest['grpc-1'];
    expect(after?.live).toBeUndefined();
    expect(after?.exchange).toBeDefined();
  });

  it('ignores an event for a send no request is running', () => {
    void startSend();
    live({ kind: 'message', sendId: 'nobody-is-listening', index: 0, message: message('{}') });

    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.live?.messages).toEqual([]);
  });

  it('drops the live half once the exchange arrives, so no message is shown twice', async () => {
    sendGrpc.mockResolvedValue({ ok: true, value: makeGrpcExchange() });
    await useExchangesStore.getState().sendGrpc('grpc-1');

    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.live).toBeUndefined();
  });
});

describe('an interactive call', () => {
  it('asks main to keep the request side open', () => {
    void startSend({ interactive: true });

    expect(sendGrpc.mock.calls[0]?.[0]).toMatchObject({ interactive: true });
  });

  it('pushes a message on the open call and records what was sent', async () => {
    void startSend({ interactive: true });
    const sendId = sendIdOf();
    live({ kind: 'open', sendId });

    await useExchangesStore.getState().pushGrpcMessage('grpc-1', '{"name":"Ada"}');

    expect(grpcPush).toHaveBeenCalledWith({ sendId, messageText: '{"name":"Ada"}' });
    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.live?.sent).toEqual(['{\n  "name": "Ada"\n}']);
  });

  it('will not push into a call whose request side is not open', async () => {
    void startSend({ interactive: true });

    await useExchangesStore.getState().pushGrpcMessage('grpc-1', '{"name":"Ada"}');

    expect(grpcPush).not.toHaveBeenCalled();
  });

  it('half-closes the open call', async () => {
    void startSend({ interactive: true });
    const sendId = sendIdOf();
    live({ kind: 'open', sendId });

    await useExchangesStore.getState().halfCloseGrpc('grpc-1');

    expect(grpcHalfClose).toHaveBeenCalledWith({ sendId });
  });

  it('keeps a refused push out of the sent list', async () => {
    grpcPush.mockResolvedValue({ ok: false, error: { code: 'grpc-message-invalid', message: 'not JSON' } });
    void startSend({ interactive: true });
    live({ kind: 'open', sendId: sendIdOf() });

    await useExchangesStore.getState().pushGrpcMessage('grpc-1', 'not json');

    expect(useExchangesStore.getState().grpcByRequest['grpc-1']?.live?.sent).toEqual([]);
  });
});
