// @vitest-environment node
/**
 * `${secret:name}` tokens through the send paths' own entry points, against real servers: a
 * WebSocket session opened and messaged over IPC, a gRPC call, and a History resend. The value goes
 * out on the wire; what comes back to the renderer and what History writes shows it masked (unless
 * the session shows secrets, which History never honours).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startTestGrpcServer,
  startTestWsServer,
  type TestGrpcServer,
  type TestWsServer,
} from '@wirebench/engine/test-helpers';
import {
  createGrpcApi,
  createGrpcRequest,
  createProject,
  createWsApi,
  createWsRequest,
  entry,
} from '@wirebench/engine';
import type { GetSecret, HistoryEntry, Project, PropertyScopes } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { resolveGrpcSend } from '../src/main/grpc-send.js';
import {
  buildGrpcHistoryEntry,
  buildHistoryEntry,
  buildWsHistoryEntry,
  type RecordGrpcSendInput,
  type RecordSendInput,
  type RecordWsSessionInput,
} from '../src/main/history-service.js';
import { registerHistoryChannels } from '../src/main/ipc/history.js';
import { registerRequestChannels, sendGrpcRequest, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { recordSecretValue } from '../src/main/redact.js';
import { projectSecretGetter, secretStoreLabel } from '../src/main/secret-resolver.js';
import { SecretStore, type CryptoBackend } from '../src/main/secrets.js';
import { resolveWsSend } from '../src/main/ws-send.js';
import type {
  GrpcExchangeSummary,
  GrpcResponseMessageWire,
  HistoryEntryWire,
  WsFrameWire,
} from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const SCOPES: PropertyScopes = { project: {}, global: {}, system: {} };

function invoke(channel: string, payload: unknown, sender: unknown = fakeSender().sender): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender }, payload);
}

function unwrap<T>(result: unknown): T {
  const envelope = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!envelope.ok) {
    throw new Error(`ipc failed: ${envelope.error?.code} ${envelope.error?.message}`);
  }
  return envelope.value as T;
}

function fakeSender(): {
  sender: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
  events: unknown[];
} {
  const events: unknown[] = [];
  return {
    sender: { isDestroyed: () => false, send: (_channel: string, payload: unknown) => events.push(payload) },
    events,
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeCrypto(): CryptoBackend {
  return {
    available: true,
    encrypt: (text) => Buffer.from(`enc:${text}`, 'utf8'),
    decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
}

let dir: string;
let store: SecretStore;

beforeEach(() => {
  handlers.clear();
  dir = mkdtempSync(join(tmpdir(), 'wirebench-ipc-secret-send-'));
  store = new SecretStore(dir, fakeCrypto());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function getterFor(projectId: string | undefined): GetSecret {
  return projectSecretGetter(store, projectId, recordSecretValue);
}

let wsServer: TestWsServer;
let grpcServer: TestGrpcServer;

beforeAll(async () => {
  wsServer = await startTestWsServer();
  grpcServer = await startTestGrpcServer();
});

afterAll(async () => {
  await wsServer.close();
  await grpcServer.close();
});

function wsProject(header: string): Project {
  return {
    ...createProject('Chat', { id: 'p1' }),
    wsApis: [
      createWsApi('Chat', {
        id: 'w-1',
        url: wsServer.url,
        requests: [createWsRequest('Echo', { id: 'ws-1', url: '/echo', headers: [entry('x-token', header)] })],
      }),
    ],
  };
}

/** The WebSocket channels over a real project, recording History through the real entry builder. */
function registerWs(options: { header?: string; show?: boolean; secretsFor?: (id: string | undefined) => GetSecret }) {
  const project = wsProject(options.header ?? 'plain');
  const written: HistoryEntry[] = [];
  registerRequestChannels(new EngineService(), {
    project: {
      scopesFor: () => SCOPES,
      projectId: () => 'p1',
      authFor: () => undefined,
      requestMeta: () => undefined,
      wsSend: (requestId: string) =>
        resolveWsSend({
          project,
          requestId,
          scopes: SCOPES,
          resolveTarget: (api) => ({ url: api.url, source: 'api' }),
        }),
      wsTlsFor: () => Promise.resolve(undefined),
      wsMeta: () => ({ requestName: 'Echo', apiName: 'Chat', folderPath: '' }),
    } as unknown as RequestChannelDeps['project'],
    getSecret: () => Promise.resolve(undefined),
    secretsFor: options.secretsFor ?? getterFor,
    ...(options.show === true ? { showSecrets: { get: () => true } } : {}),
    history: {
      recordWsSession: (projectId: string, record: RecordWsSessionInput) => {
        written.push(buildWsHistoryEntry(projectId, record));
        return Promise.resolve({ id: 'h', kind: 'websocket' } as HistoryEntryWire);
      },
    } as never,
  });
  return { written };
}

function frameEvents(events: readonly unknown[]): WsFrameWire[] {
  return events
    .filter((e) => (e as { kind?: string }).kind === 'frame')
    .map((e) => (e as { frame: WsFrameWire }).frame);
}

describe('a WebSocket session with tokens', () => {
  it('opens with a header token resolved through the store, masked in the handshake it reports', async () => {
    await store.set('fake-ws-open-token-0001', { label: secretStoreLabel('p1', 'ws_open') });
    registerWs({ header: 'Key ${secret:ws_open}' });
    const { sender, events } = fakeSender();

    const open = invoke('request.openWs', { sendId: 'o1', requestId: 'ws-1' }, sender);
    await waitFor(() => events.some((e) => (e as { kind?: string }).kind === 'handshake'), 'the handshake');
    unwrap(await invoke('request.wsClose', { sendId: 'o1' }));
    const summary = unwrap<{ handshake: { requestHeaders: Record<string, string> } }>(await open);

    expect(wsServer.handshakes.at(-1)?.headers['x-token']).toBe('Key fake-ws-open-token-0001');
    expect(summary.handshake.requestHeaders['x-token']).toBe('Key <redacted>');
    expect(JSON.stringify(events)).not.toContain('fake-ws-open-token-0001');
  });

  it('sends a message token, masking it in the reply, the live frames, the summary and History', async () => {
    await store.set('fake-ws-message-token-01', { label: secretStoreLabel('p1', 'ws_msg') });
    const { written } = registerWs({});
    const { sender, events } = fakeSender();
    const before = wsServer.received.length;

    const open = invoke('request.openWs', { sendId: 'm1', requestId: 'ws-1' }, sender);
    await waitFor(() => events.some((e) => (e as { kind?: string }).kind === 'handshake'), 'the handshake');
    const reply = unwrap<WsFrameWire>(
      await invoke('request.wsSend', {
        sendId: 'm1',
        requestId: 'ws-1',
        format: 'text',
        content: '{"token":"${secret:ws_msg}"}',
        expand: true,
      }),
    );
    await waitFor(() => frameEvents(events).some((f) => f.direction === 'received'), 'the echo');
    unwrap(await invoke('request.wsClose', { sendId: 'm1' }));
    const summary = unwrap<{ frames: WsFrameWire[] }>(await open);

    expect(wsServer.received.slice(before)[0]?.payload.toString('utf8')).toBe('{"token":"fake-ws-message-token-01"}');
    expect(reply.text).toBe('{"token":"<redacted>"}');
    const texts = frameEvents(events).filter((f) => f.opcode === 'text');
    expect(texts.map((f) => [f.direction, f.text])).toEqual([
      ['sent', '{"token":"<redacted>"}'],
      ['received', '{"token":"<redacted>"}'],
    ]);
    expect(JSON.stringify(summary)).not.toContain('fake-ws-message-token-01');
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written[0])).not.toContain('fake-ws-message-token-01');
  });

  it('shows the value while secrets are shown, but History masks it all the same', async () => {
    await store.set('fake-ws-shown-token-0001', { label: secretStoreLabel('p1', 'ws_shown') });
    const { written } = registerWs({ show: true });
    const { sender, events } = fakeSender();

    const open = invoke('request.openWs', { sendId: 'm2', requestId: 'ws-1' }, sender);
    await waitFor(() => events.some((e) => (e as { kind?: string }).kind === 'handshake'), 'the handshake');
    const reply = unwrap<WsFrameWire>(
      await invoke('request.wsSend', {
        sendId: 'm2',
        requestId: 'ws-1',
        format: 'text',
        content: 't=${secret:ws_shown}',
        expand: true,
      }),
    );
    await waitFor(() => frameEvents(events).some((f) => f.direction === 'received'), 'the echo');
    unwrap(await invoke('request.wsClose', { sendId: 'm2' }));
    const summary = unwrap<{ frames: WsFrameWire[] }>(await open);

    expect(reply.text).toBe('t=fake-ws-shown-token-0001');
    expect(summary.frames.map((f) => f.text)).toContain('t=fake-ws-shown-token-0001');
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written[0])).not.toContain('fake-ws-shown-token-0001');
    expect(written[0]!.ws?.frames.map((f) => f.text)).toContain('t=<redacted>');
  });

  /** Opens a session, records `${secret:name}` with a text send, then echoes the binary payloads. */
  async function echoBinary(sendId: string, name: string, show: boolean, payloads: readonly Buffer[]) {
    const { written } = registerWs({ show });
    const { sender, events } = fakeSender();
    const open = invoke('request.openWs', { sendId, requestId: 'ws-1' }, sender);
    await waitFor(() => events.some((e) => (e as { kind?: string }).kind === 'handshake'), 'the handshake');
    unwrap(
      await invoke('request.wsSend', {
        sendId,
        requestId: 'ws-1',
        format: 'text',
        content: `\${secret:${name}}`,
        expand: true,
      }),
    );
    const replies: WsFrameWire[] = [];
    for (const payload of payloads) {
      replies.push(
        unwrap<WsFrameWire>(
          await invoke('request.wsSend', {
            sendId,
            requestId: 'ws-1',
            format: 'binary',
            content: payload.toString('base64'),
            expand: false,
          }),
        ),
      );
    }
    const received = () => frameEvents(events).filter((f) => f.direction === 'received' && f.opcode === 'binary');
    await waitFor(() => received().length === payloads.length, 'the binary echoes');
    unwrap(await invoke('request.wsClose', { sendId }));
    const summary = unwrap<{ frames: WsFrameWire[] }>(await open);
    const binary = (frames: readonly { opcode: string; base64?: string | undefined }[]) =>
      frames.filter((f) => f.opcode === 'binary').map((f) => Buffer.from(f.base64 ?? '', 'base64'));
    return { replies, received: received(), summary, written, binary };
  }

  it('masks a token value in a binary frame that is UTF-8 text, on the wire and in History', async () => {
    const value = 'fake-ws-binary-token-001';
    await store.set(value, { label: secretStoreLabel('p1', 'ws_bin') });
    const text = Buffer.from(`{"k":"${value}","é":1}`, 'utf8');
    const { replies, received, summary, written, binary } = await echoBinary('b1', 'ws_bin', false, [text]);

    const masked = '{"k":"<redacted>","é":1}';
    expect(Buffer.from(replies[0]!.base64 ?? '', 'base64').toString('utf8')).toBe(masked);
    expect(received.map((f) => Buffer.from(f.base64 ?? '', 'base64').toString('utf8'))).toEqual([masked]);
    // `size` is the payload as it went over the wire, as a text frame's is.
    expect(received[0]!.size).toBe(text.length);
    expect(binary(summary.frames).map((b) => b.toString('utf8'))).toEqual([masked, masked]);
    expect(written).toHaveLength(1);
    expect(binary(written[0]!.ws?.frames ?? []).map((b) => b.toString('utf8'))).toEqual([masked, masked]);
  });

  it('shows a binary frame as it was while secrets are shown, but History masks it all the same', async () => {
    const value = 'fake-ws-binary-shown-001';
    await store.set(value, { label: secretStoreLabel('p1', 'ws_bin_shown') });
    const text = Buffer.from(`k=${value}`, 'utf8');
    const { replies, received, summary, written, binary } = await echoBinary('b2', 'ws_bin_shown', true, [text]);

    expect(Buffer.from(replies[0]!.base64 ?? '', 'base64')).toEqual(text);
    expect(Buffer.from(received[0]!.base64 ?? '', 'base64')).toEqual(text);
    expect(binary(summary.frames)).toEqual([text, text]);
    expect(binary(written[0]!.ws?.frames ?? []).map((b) => b.toString('utf8'))).toEqual([
      'k=<redacted>',
      'k=<redacted>',
    ]);
  });

  it('passes a binary frame that is not UTF-8 through byte for byte', async () => {
    const value = 'fake-ws-binary-bytes-001';
    await store.set(value, { label: secretStoreLabel('p1', 'ws_bin_bytes') });
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(value, 'utf8')]);
    const { replies, received, summary, written, binary } = await echoBinary('b3', 'ws_bin_bytes', false, [bytes]);

    expect(replies[0]!.base64).toBe(bytes.toString('base64'));
    expect(received[0]!.base64).toBe(bytes.toString('base64'));
    expect(binary(summary.frames)).toEqual([bytes, bytes]);
    expect(binary(written[0]!.ws?.frames ?? [])).toEqual([bytes, bytes]);
  });

  it('keeps messages in the order they were sent while a token waits on the keychain', async () => {
    await store.set('fake-ws-slow-token-00001', { label: secretStoreLabel('p1', 'slow') });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = (projectId: string | undefined): GetSecret => {
      const inner = getterFor(projectId);
      return async (ref) => {
        await gate;
        return inner(ref);
      };
    };
    registerWs({ secretsFor: slow });
    const { sender, events } = fakeSender();
    const before = wsServer.received.length;

    const open = invoke('request.openWs', { sendId: 'q1', requestId: 'ws-1' }, sender);
    await waitFor(() => events.some((e) => (e as { kind?: string }).kind === 'handshake'), 'the handshake');
    const first = invoke('request.wsSend', {
      sendId: 'q1',
      requestId: 'ws-1',
      format: 'text',
      content: 'first ${secret:slow}',
      expand: true,
    });
    const second = invoke('request.wsSend', {
      sendId: 'q1',
      requestId: 'ws-1',
      format: 'text',
      content: 'second',
      expand: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wsServer.received.length).toBe(before);
    release();
    unwrap(await first);
    unwrap(await second);
    await waitFor(() => wsServer.received.length >= before + 2, 'both messages');
    unwrap(await invoke('request.wsClose', { sendId: 'q1' }));
    await open;

    expect(wsServer.received.slice(before, before + 2).map((f) => f.payload.toString('utf8'))).toEqual([
      'first fake-ws-slow-token-00001',
      'second',
    ]);
  });

  it('keeps sending after a message is refused', async () => {
    registerWs({});
    const { sender, events } = fakeSender();
    const before = wsServer.received.length;

    const open = invoke('request.openWs', { sendId: 'r1', requestId: 'ws-1' }, sender);
    await waitFor(() => events.some((e) => (e as { kind?: string }).kind === 'handshake'), 'the handshake');
    const refused = (await invoke('request.wsSend', {
      sendId: 'r1',
      requestId: 'ws-1',
      format: 'text',
      content: '${secret:not_stored}',
      expand: true,
    })) as { ok: boolean; error?: { code: string } };
    const next = unwrap<WsFrameWire>(
      await invoke('request.wsSend', { sendId: 'r1', requestId: 'ws-1', format: 'text', content: 'ok', expand: true }),
    );
    unwrap(await invoke('request.wsClose', { sendId: 'r1' }));
    await open;

    expect(refused).toMatchObject({ ok: false, error: { code: 'secret-missing' } });
    expect(next.text).toBe('ok');
    expect(wsServer.received.slice(before).map((f) => f.payload.toString('utf8'))[0]).toBe('ok');
  });
});

describe('a gRPC call with tokens', () => {
  function grpcProject(): Project {
    return {
      ...createProject('Demo', { id: 'p1' }),
      grpcApis: [
        createGrpcApi('Greeter', {
          id: 'g-1',
          target: grpcServer.target,
          tls: false,
          requests: [
            createGrpcRequest('SayHello', {
              id: 'q-1',
              service: 'wirebench.greet.Greeter',
              method: 'SayHello',
              message: '{"name": "${secret:grpc_name}"}',
              metadata: [entry('x-token', '${secret:grpc_token}')],
            }),
            createGrpcRequest('Fail', {
              id: 'q-2',
              service: 'wirebench.greet.Greeter',
              method: 'Fail',
              message: '{"code": 5, "message": "no such ${secret:grpc_name}"}',
            }),
          ],
        }),
      ],
    };
  }

  function grpcDeps(show: boolean, written: HistoryEntry[] = []): RequestChannelDeps {
    const project = grpcProject();
    return {
      project: {
        scopesFor: () => SCOPES,
        projectId: () => 'p1',
        grpcSend: (requestId: string) =>
          resolveGrpcSend({
            project,
            requestId,
            scopes: SCOPES,
            resolveTarget: (api) => ({ url: api.target, source: 'api' }),
          }),
        grpcProtoSetFor: () => Promise.resolve(grpcServer.set),
        grpcTlsFor: () => Promise.resolve(undefined),
      } as unknown as RequestChannelDeps['project'],
      secretsFor: getterFor,
      ...(show ? { showSecrets: { get: () => true } } : {}),
      history: {
        recordGrpcSend: (projectId: string, record: RecordGrpcSendInput) => {
          written.push(buildGrpcHistoryEntry(projectId, record));
          return Promise.resolve(undefined);
        },
      } as never,
    };
  }

  /** Every base64 field of a summary's `http`, decoded, so a value in raw bytes is seen too. */
  function decodedHttp(summary: GrpcExchangeSummary): string {
    const { bodyBase64, rawBodyBase64, rawRequestBase64, rawResponseBase64 } = summary.http;
    return [bodyBase64, rawBodyBase64, rawRequestBase64, rawResponseBase64]
      .map((base64) => Buffer.from(base64, 'base64').toString('latin1'))
      .join('\n');
  }

  function messageEvents(events: readonly unknown[]): GrpcResponseMessageWire[] {
    return events
      .filter((e) => (e as { kind?: string }).kind === 'message')
      .map((e) => (e as { message: GrpcResponseMessageWire }).message);
  }

  it('resolves tokens through the store, and masks them in the request messages it returns', async () => {
    await store.set('fake-grpc-name-00000001', { label: secretStoreLabel('p1', 'grpc_name') });
    await store.set('fake-grpc-token-0000001', { label: secretStoreLabel('p1', 'grpc_token') });

    const summary = await sendGrpcRequest(
      new EngineService(),
      grpcDeps(false),
      { sendId: 'g1', requestId: 'q-1' },
      fakeSender().sender as never,
    );

    const call = grpcServer.calls.at(-1);
    expect(call?.headers['x-token']).toBe('fake-grpc-token-0000001');
    expect(JSON.stringify(call)).toContain('fake-grpc-name-00000001');
    expect(summary.requestMessages.join('')).not.toContain('fake-grpc-name-00000001');
    expect(summary.requestMessages.join('')).toContain('<redacted>');
    expect(summary.http.request.headers['x-token']).toBe('<redacted>');

    const shown = await sendGrpcRequest(
      new EngineService(),
      grpcDeps(true),
      { sendId: 'g2', requestId: 'q-1' },
      fakeSender().sender as never,
    );
    expect(shown.requestMessages.join('')).toContain('fake-grpc-name-00000001');
  });

  it('masks a value the server echoes in its response messages, live and in the summary', async () => {
    const value = 'fake-grpc-echo-00000001';
    await store.set(value, { label: secretStoreLabel('p1', 'grpc_name') });
    await store.set('fake-grpc-token-0000002', { label: secretStoreLabel('p1', 'grpc_token') });
    const written: HistoryEntry[] = [];
    const { sender, events } = fakeSender();

    const summary = await sendGrpcRequest(
      new EngineService(),
      grpcDeps(false, written),
      { sendId: 'g3', requestId: 'q-1' },
      sender as never,
    );

    expect(JSON.stringify(grpcServer.calls.at(-1))).toContain(value);
    const live = messageEvents(events);
    expect(live).toHaveLength(1);
    expect(live[0]!.json).toContain('"message": "Hello, <redacted>"');
    expect(JSON.stringify(events)).not.toContain(value);
    expect(summary.responseMessages[0]!.json).toContain('"message": "Hello, <redacted>"');
    expect(JSON.stringify(summary)).not.toContain(value);
    expect(decodedHttp(summary)).not.toContain(value);
    // The message's size is the one the server sent, as a WebSocket frame's is.
    expect(summary.responseMessages[0]!.bytes).toBe(live[0]!.bytes);
    expect(JSON.stringify(written)).not.toContain(value);
  });

  it('shows an echoed value while secrets are shown, but History masks it all the same', async () => {
    const value = 'fake-grpc-echo-shown-01';
    await store.set(value, { label: secretStoreLabel('p1', 'grpc_name') });
    await store.set('fake-grpc-token-0000003', { label: secretStoreLabel('p1', 'grpc_token') });
    const written: HistoryEntry[] = [];
    const { sender, events } = fakeSender();

    const summary = await sendGrpcRequest(
      new EngineService(),
      grpcDeps(true, written),
      { sendId: 'g4', requestId: 'q-1' },
      sender as never,
    );

    expect(messageEvents(events)[0]!.json).toContain(`"message": "Hello, ${value}"`);
    expect(summary.responseMessages[0]!.json).toContain(`"message": "Hello, ${value}"`);
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written[0])).not.toContain(value);
    expect(written[0]!.grpc?.responseMessages.join('')).toContain('Hello, <redacted>');
  });

  it('masks a value the server echoes in its status message and trailers', async () => {
    const value = 'fake-grpc-status-000001';
    await store.set(value, { label: secretStoreLabel('p1', 'grpc_name') });
    const written: HistoryEntry[] = [];
    const { sender, events } = fakeSender();

    const summary = await sendGrpcRequest(
      new EngineService(),
      grpcDeps(false, written),
      { sendId: 'g5', requestId: 'q-2' },
      sender as never,
    );

    expect(summary.status).toBe(5);
    expect(summary.statusMessage).toBe('no such <redacted>');
    expect(JSON.stringify(summary)).not.toContain(value);
    expect(decodedHttp(summary)).not.toContain(value);
    expect(JSON.stringify(events)).not.toContain(value);

    const shown = await sendGrpcRequest(
      new EngineService(),
      grpcDeps(true, written),
      { sendId: 'g6', requestId: 'q-2' },
      fakeSender().sender as never,
    );
    expect(shown.statusMessage).toBe(`no such ${value}`);
    expect(written).toHaveLength(2);
    expect(JSON.stringify(written)).not.toContain(value);
    expect(written.map((entry) => entry.grpc?.statusMessage)).toEqual(['no such <redacted>', 'no such <redacted>']);
  });
});

describe('a History resend with a token', () => {
  interface Captured {
    readonly headers: IncomingMessage['headers'];
    readonly body: string;
  }
  let server: Server;
  let url: string;
  const captured: Captured[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        captured.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end('<Envelope><Body/></Envelope>');
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    url = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}/soap`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('replays the live request, resolving its token through the store, and records it masked', async () => {
    await store.set('fake-resend-password-01', { label: secretStoreLabel('p1', 'resend_pw') });
    const written: HistoryEntry[] = [];
    const recordSend = vi.fn((projectId: string, record: RecordSendInput) => {
      written.push(buildHistoryEntry(projectId, record));
      return Promise.resolve(undefined);
    });
    const entry: HistoryEntryWire = {
      id: 'h-1',
      at: '2026-01-01T00:00:00.000Z',
      projectId: 'p1',
      requestId: 'req-1',
      requestName: 'Add',
      interfaceName: 'Calc',
      operationName: 'Add',
      endpoint: url,
      soapVersion: '1.1',
      durationMs: 5,
      ok: true,
      status: 200,
      request: { envelopeXml: '<Envelope><Pw><redacted></Pw></Envelope>', headers: [] },
      sizeBytes: 10,
    };
    registerHistoryChannels(
      new EngineService(),
      {
        get: (id: string) => (id === 'h-1' ? entry : undefined),
        recordSend,
      } as never,
      {
        project: {
          scopesFor: () => SCOPES,
          authFor: () => undefined,
          requestMeta: () => undefined,
          projectId: () => 'p1',
          buildLiveSendInput: () => ({
            endpoint: url,
            envelopeXml: '<Envelope><Pw>${secret:resend_pw}</Pw></Envelope>',
            soapVersion: '1.1',
          }),
        },
        secretsFor: getterFor,
      },
    );
    const before = captured.length;

    const summary = unwrap<{ http: { rawRequestBase64: string } }>(await invoke('history.resend', { id: 'h-1' }));

    expect(captured.slice(before)[0]?.body).toContain('<Pw>fake-resend-password-01</Pw>');
    expect(Buffer.from(summary.http.rawRequestBase64, 'base64').toString('utf8')).not.toContain(
      'fake-resend-password-01',
    );
    expect(recordSend).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written[0])).not.toContain('fake-resend-password-01');
  });
});
