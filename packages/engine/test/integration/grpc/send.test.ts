/**
 * `sendGrpc` and `callGrpc` against a real HTTP/2 gRPC server in this process: every streaming
 * shape, metadata both ways, statuses in trailers and in headers, deadlines, cancellation,
 * compression, TLS, and the failures a server that is not gRPC produces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GrpcError, HttpError, ProtoError } from '../../../src/errors.js';
import { callGrpc } from '../../../src/grpc/call.js';
import { encodeMessage } from '../../../src/grpc/codec.js';
import { sendGrpc, type GrpcSendInput } from '../../../src/grpc/send.js';
import { entry } from '../../../src/rest/model.js';
import { generateServerCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestGrpcServer, type TestGrpcServer } from '../../helpers/test-grpc-server.js';
import { startTestRestServer, type TestRestServer } from '../../helpers/test-rest-server.js';

let server: TestGrpcServer;

beforeAll(async () => {
  server = await startTestGrpcServer();
});

afterAll(async () => {
  await server.close();
});

const SERVICE = 'wirebench.greet.Greeter';

function input(overrides: Partial<GrpcSendInput> = {}): GrpcSendInput {
  return {
    target: server.target,
    tls: false,
    service: SERVICE,
    method: 'SayHello',
    messages: [encodeMessage(server.set, 'wirebench.greet.HelloRequest', { name: 'Ada' })],
    metadata: [],
    timeoutMs: 5000,
    ...overrides,
  };
}

function call(overrides: Partial<Parameters<typeof callGrpc>[0]> = {}) {
  return callGrpc({
    set: server.set,
    target: server.target,
    tls: false,
    service: SERVICE,
    method: 'SayHello',
    messageText: '{"name": "Ada"}',
    metadata: [],
    timeoutMs: 5000,
    ...overrides,
  });
}

describe('sendGrpc', () => {
  it('makes a unary call and reads the status from the trailers', async () => {
    const exchange = await sendGrpc(
      input({ metadata: [entry('X-Trace', 'abc')], defaultMetadata: { 'user-agent': 'wirebench-test' } }),
    );
    expect(exchange.httpStatus).toBe(200);
    expect(exchange.status).toBe(0);
    expect(exchange.statusName).toBe('OK');
    expect(exchange.statusSource).toBe('trailers');
    expect(exchange.messages).toHaveLength(1);
    expect(exchange.headers['x-served-by']).toBe('test-grpc-server');
    expect(exchange.headers['content-type']).toBe('application/grpc+proto');
    expect(exchange.trailers['grpc-status']).toBe('0');
    expect(exchange.request.path).toBe('/wirebench.greet.Greeter/SayHello');
    expect(exchange.request.headers['grpc-timeout']).toBe('5000m');
    expect(exchange.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(exchange.timings.ttfbMs).toBeDefined();
    expect(exchange.tls).toBeUndefined();
    const recorded = server.calls.at(-1)!;
    expect(recorded.headers['x-trace']).toBe('abc');
    expect(recorded.headers['user-agent']).toBe('wirebench-test');
    expect(recorded.headers['te']).toBe('trailers');
    expect(recorded.messages).toEqual([{ name: 'Ada' }]);
    const raw = Buffer.from(exchange.rawRequest).toString('latin1');
    expect(raw.startsWith(':method: POST\r\n')).toBe(true);
    expect(Buffer.from(exchange.rawResponse).toString('latin1')).toContain('grpc-status: 0');
  });

  it('reads every message of a server stream', async () => {
    const exchange = await sendGrpc(
      input({
        method: 'LotsOfReplies',
        messages: [encodeMessage(server.set, 'wirebench.greet.StreamRequest', { count: 3 })],
      }),
    );
    expect(exchange.status).toBe(0);
    expect(exchange.messages).toHaveLength(3);
  });

  it('sends every message of a client stream before half-closing', async () => {
    const messages = ['a', 'b', 'c'].map((name) => encodeMessage(server.set, 'wirebench.greet.HelloRequest', { name }));
    const exchange = await sendGrpc(input({ method: 'LotsOfGreetings', messages }));
    expect(exchange.messages).toHaveLength(1);
    expect(server.calls.at(-1)?.messages).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  });

  it('reports a non-OK status from the trailers as a result, not an error', async () => {
    const exchange = await sendGrpc(
      input({
        method: 'Fail',
        messages: [encodeMessage(server.set, 'wirebench.greet.FailRequest', { code: 5, message: 'no such café' })],
      }),
    );
    expect(exchange).toMatchObject({
      status: 5,
      statusName: 'NOT_FOUND',
      statusMessage: 'no such café',
      statusSource: 'trailers',
      messages: [],
    });
  });

  it('reads a trailers-only response from the headers', async () => {
    const exchange = await sendGrpc(
      input({
        method: 'Fail',
        messages: [
          encodeMessage(server.set, 'wirebench.greet.FailRequest', {
            code: 16,
            message: 'who are you',
            trailers_only: true,
          }),
        ],
      }),
    );
    expect(exchange).toMatchObject({
      status: 16,
      statusName: 'UNAUTHENTICATED',
      statusMessage: 'who are you',
      statusSource: 'headers',
    });
  });

  it('answers UNIMPLEMENTED for a method the server does not have', async () => {
    const exchange = await sendGrpc(input({ method: 'Nope' }));
    expect(exchange.status).toBe(12);
    expect(exchange.statusMessage).toContain('/wirebench.greet.Greeter/Nope');
  });

  it('enforces the deadline locally as DEADLINE_EXCEEDED', async () => {
    const exchange = await sendGrpc(
      input({
        method: 'Slow',
        timeoutMs: 100,
        messages: [encodeMessage(server.set, 'wirebench.greet.StreamRequest', { delay_ms: 2000 })],
      }),
    );
    expect(exchange).toMatchObject({ status: 4, statusName: 'DEADLINE_EXCEEDED', statusSource: 'local' });
    expect(exchange.request.headers['grpc-timeout']).toBe('100m');
    expect(exchange.durationMs).toBeLessThan(1500);
  });

  it('aborts on the caller signal', async () => {
    const controller = new AbortController();
    const pending = sendGrpc(
      input({
        method: 'Slow',
        signal: controller.signal,
        messages: [encodeMessage(server.set, 'wirebench.greet.StreamRequest', { delay_ms: 2000 })],
      }),
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects an already-aborted signal without connecting', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sendGrpc(input({ signal: controller.signal }))).rejects.toBeInstanceOf(HttpError);
  });

  it('stops reading at maxSizeBytes and says so', async () => {
    const exchange = await sendGrpc(
      input({
        method: 'LotsOfReplies',
        maxSizeBytes: 40,
        messages: [encodeMessage(server.set, 'wirebench.greet.StreamRequest', { count: 50 })],
      }),
    );
    expect(exchange.truncated).toBe(true);
    expect(exchange.messages.length).toBeLessThan(50);
  });

  it('reports a connection refusal with the HTTP transport code', async () => {
    await expect(sendGrpc(input({ target: '127.0.0.1:1' }))).rejects.toMatchObject({ code: 'connection-refused' });
  });

  it('tells a server that is not gRPC apart from one that is', async () => {
    let rest: TestRestServer | undefined;
    try {
      rest = await startTestRestServer();
      const url = new URL(rest.url);
      await expect(sendGrpc(input({ target: `${url.hostname}:${url.port}` }))).rejects.toSatisfy(
        (error: unknown) => error instanceof GrpcError || error instanceof HttpError,
      );
    } finally {
      await rest?.close();
    }
  });
});

describe('sendGrpc with compression', () => {
  let gzipServer: TestGrpcServer;
  beforeAll(async () => {
    gzipServer = await startTestGrpcServer({ gzip: true });
  });
  afterAll(async () => {
    await gzipServer.close();
  });

  it('decompresses gzip frames and records the encoding', async () => {
    const exchange = await sendGrpc(input({ target: gzipServer.target }));
    expect(exchange.encoding).toBe('gzip');
    expect(exchange.messages).toHaveLength(1);
    const result = await call({ target: gzipServer.target, set: gzipServer.set });
    expect(result.responseMessages[0]?.json).toMatchObject({ message: 'Hello, Ada' });
  });
});

describe('sendGrpc over TLS', () => {
  let tlsServer: TestGrpcServer;
  const ca = generateTestCa();
  const cert = generateServerCert(ca);
  beforeAll(async () => {
    tlsServer = await startTestGrpcServer({ tls: { cert: cert.certPem, key: cert.keyPem } });
  });
  afterAll(async () => {
    await tlsServer.close();
  });

  it('connects with the CA trusted and reports the peer chain', async () => {
    const exchange = await sendGrpc(
      input({ target: tlsServer.target, tls: true, tlsOptions: { ca: [ca.certPem], servername: 'localhost' } }),
    );
    expect(exchange.status).toBe(0);
    expect(exchange.tls?.authorized).toBe(true);
    expect(exchange.tls?.alpn).toBe('h2');
    expect(exchange.tls?.peerChain[0]?.subject).toContain('CN=localhost');
    expect(exchange.timings.connectMs).toBeDefined();
  });

  it('refuses an untrusted certificate with the remedy-shaped code, and proceeds when told to trust it', async () => {
    await expect(sendGrpc(input({ target: tlsServer.target, tls: true }))).rejects.toMatchObject({
      code: 'tls-untrusted',
    });
    const exchange = await sendGrpc(
      input({ target: tlsServer.target, tls: true, tlsOptions: { rejectUnauthorized: false } }),
    );
    expect(exchange.status).toBe(0);
    expect(exchange.tls?.authorized).toBe(false);
  });
});

describe('callGrpc', () => {
  it('encodes the message text, sends, and decodes every response message', async () => {
    const result = await call({ metadata: [entry('x-tenant', 'acme')] });
    expect(result.methodKind).toBe('unary');
    expect(result.requestType).toBe('wirebench.greet.HelloRequest');
    expect(result.responseType).toBe('wirebench.greet.HelloReply');
    expect(result.requestMessages).toEqual([{ name: 'Ada' }]);
    expect(result.responseMessages).toHaveLength(1);
    expect(result.responseMessages[0]?.json).toEqual({
      message: 'Hello, Ada',
      echo: { name: 'Ada' },
      metadata: { 'x-tenant': 'acme' },
    });
    expect(result.exchange.status).toBe(0);
  });

  it('sends a JSON array as a client stream and answers a bidirectional stream per message', async () => {
    const upload = await call({ method: 'LotsOfGreetings', messageText: '[{"name":"a"},{"name":"b"}]' });
    expect(upload.methodKind).toBe('client-streaming');
    expect(upload.responseMessages[0]?.json).toMatchObject({ message: 'Received 2 greetings', sequence: 2 });
    const chat = await call({ method: 'Chat', messageText: '[{"name":"a"},{"name":"b"},{"name":"c"}]' });
    expect(chat.methodKind).toBe('bidi-streaming');
    expect(chat.responseMessages.map((m) => (m.json as { message: string }).message)).toEqual([
      'Hello, a',
      'Hello, b',
      'Hello, c',
    ]);
  });

  it('refuses a message that does not fit the request type before connecting', async () => {
    await expect(call({ messageText: '{"nmae": "x"}' })).rejects.toBeInstanceOf(ProtoError);
    await expect(call({ messageText: '[{}]' })).rejects.toMatchObject({ code: 'grpc-message-invalid' });
    await expect(call({ method: 'Nope' })).rejects.toMatchObject({ code: 'proto-method-unknown' });
  });
});
