/**
 * The live half of a gRPC call against the in-process server: the initial metadata and each
 * response message reported as they arrive rather than at the end, and an interactive call whose
 * request side the caller keeps open and pushes into.
 *
 * What these assert that a batch test cannot is *when* things happen. Every hook records whether
 * the call had already resolved when it fired, so "the messages arrived before the call ended" is
 * a fact about ordering, not a guess about timing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrpcError } from '../../../src/errors.js';
import { callGrpc, type GrpcCallStreamHandle, type GrpcResponseMessage } from '../../../src/grpc/call.js';
import { encodeMessage } from '../../../src/grpc/codec.js';
import { sendGrpc } from '../../../src/grpc/send.js';
import { startTestGrpcServer, type TestGrpcServer } from '../../helpers/test-grpc-server.js';

let server: TestGrpcServer;

beforeAll(async () => {
  server = await startTestGrpcServer();
});

afterAll(async () => {
  await server.close();
});

const SERVICE = 'wirebench.greet.Greeter';

/** Resolves once `predicate` holds, so a test waits on the stream rather than on a sleep. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('sendGrpc streaming hooks', () => {
  it('reports each message as it arrives, before the call ends', async () => {
    let ended = false;
    const seen: { readonly index: number; readonly afterEnd: boolean }[] = [];
    const exchange = await sendGrpc({
      target: server.target,
      tls: false,
      service: SERVICE,
      method: 'LotsOfReplies',
      messages: [encodeMessage(server.set, 'wirebench.greet.StreamRequest', { count: 4, delay_ms: 15 })],
      metadata: [],
      timeoutMs: 5000,
      onMessage: (_message, index) => {
        seen.push({ index, afterEnd: ended });
      },
    }).finally(() => {
      ended = true;
    });

    expect(seen.map((item) => item.index)).toEqual([0, 1, 2, 3]);
    expect(seen.every((item) => !item.afterEnd)).toBe(true);
    expect(exchange.messages).toHaveLength(4);
  });

  it('reports the initial metadata when the headers arrive, not when the call ends', async () => {
    let ended = false;
    let headersAfterEnd: boolean | undefined;
    let headerCount = 0;
    await sendGrpc({
      target: server.target,
      tls: false,
      service: SERVICE,
      method: 'Slow',
      messages: [encodeMessage(server.set, 'wirebench.greet.StreamRequest', { delay_ms: 60 })],
      metadata: [],
      timeoutMs: 5000,
      onHeaders: (headers, httpStatus) => {
        headerCount += 1;
        headersAfterEnd = ended;
        expect(httpStatus).toBe(200);
        expect(headers['content-type']).toMatch(/^application\/grpc/);
      },
    }).finally(() => {
      ended = true;
    });

    expect(headerCount).toBe(1);
    expect(headersAfterEnd).toBe(false);
  });

  it('leaves a call with no hooks exactly as it was', async () => {
    const exchange = await sendGrpc({
      target: server.target,
      tls: false,
      service: SERVICE,
      method: 'SayHello',
      messages: [encodeMessage(server.set, 'wirebench.greet.HelloRequest', { name: 'Ada' })],
      metadata: [],
      timeoutMs: 5000,
    });
    expect(exchange.status).toBe(0);
    expect(exchange.messages).toHaveLength(1);
    expect(exchange.request.messages).toHaveLength(1);
  });
});

describe('callGrpc streaming hooks', () => {
  it('decodes each message against the response type as it arrives', async () => {
    const live: GrpcResponseMessage[] = [];
    const result = await callGrpc({
      set: server.set,
      target: server.target,
      tls: false,
      service: SERVICE,
      method: 'LotsOfReplies',
      messageText: '{"count": 3}',
      metadata: [],
      timeoutMs: 5000,
      onMessage: (message) => {
        live.push(message);
      },
    });

    expect(live).toHaveLength(3);
    expect((live[0]?.json as { message?: string }).message).toBe('Hello #1');
    // The same messages still come back in the result, decoded the same way.
    expect(live.map((message) => message.json)).toEqual(result.responseMessages.map((message) => message.json));
  });
});

describe('an interactive bidirectional call', () => {
  /** Opens a Chat call and hands back its handle, the live messages, and the call's promise. */
  function openChat() {
    const live: GrpcResponseMessage[] = [];
    let handOver: (handle: GrpcCallStreamHandle) => void = () => undefined;
    const opened = new Promise<GrpcCallStreamHandle>((resolve) => {
      handOver = resolve;
    });
    const done = callGrpc({
      set: server.set,
      target: server.target,
      tls: false,
      service: SERVICE,
      method: 'Chat',
      // Nothing is sent up front: every message on this call is pushed by hand.
      messageText: '[]',
      metadata: [],
      timeoutMs: 5000,
      onMessage: (message) => {
        live.push(message);
      },
      onOpen: handOver,
    });
    return { live, opened, done };
  }

  it('answers each pushed message while the call is still open', async () => {
    const { live, opened, done } = openChat();
    const handle = await opened;

    expect(handle.isOpen()).toBe(true);
    const first = handle.send('{"name":"Ada"}');
    expect(first).toMatchObject({ name: 'Ada' });
    // The reply to the first message arrives before the second is written, which is what makes
    // this a conversation rather than a batch.
    await until(() => live.length === 1, 'the first reply');
    expect((live[0]?.json as { message?: string }).message).toBe('Hello, Ada');

    handle.send('{"name":"Grace"}');
    await until(() => live.length === 2, 'the second reply');
    expect((live[1]?.json as { message?: string }).message).toBe('Hello, Grace');
    expect((live[1]?.json as { sequence?: number }).sequence).toBe(2);

    handle.end();
    expect(handle.isOpen()).toBe(false);

    const result = await done;
    expect(result.exchange.status).toBe(0);
    expect(result.responseMessages).toHaveLength(2);
    // Every message pushed by hand is part of the record, not just the ones the text held.
    expect(result.requestMessages).toMatchObject([{ name: 'Ada' }, { name: 'Grace' }]);
    expect(result.exchange.request.messages).toHaveLength(2);
  });

  it('refuses to write once the request side is closed', async () => {
    const { opened, done } = openChat();
    const handle = await opened;
    handle.send('{"name":"Ada"}');
    handle.end();

    expect(() => handle.send('{"name":"late"}')).toThrow(GrpcError);
    try {
      handle.send('{"name":"late"}');
    } catch (error) {
      expect((error as GrpcError).code).toBe('grpc-stream-closed');
    }
    // A second half-close is a no-op rather than an error.
    expect(() => {
      handle.end();
    }).not.toThrow();

    const result = await done;
    expect(result.exchange.status).toBe(0);
    expect(result.requestMessages).toHaveLength(1);
  });

  it('counts the pushed messages in the raw request', async () => {
    const { opened, done } = openChat();
    const handle = await opened;
    handle.send('{"name":"Ada"}');
    handle.send('{"name":"Grace"}');
    handle.end();

    const result = await done;
    const raw = Buffer.from(result.exchange.rawRequest).toString('binary');
    expect(raw).toContain('Ada');
    expect(raw).toContain('Grace');
  });
});
