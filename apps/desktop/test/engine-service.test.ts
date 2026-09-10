import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { wrapHandler } from '../src/main/ipc/envelope.js';
import { channels } from '../src/shared/ipc.js';
import type { EngineProgressEvent } from '../src/shared/wire-types.js';

/** Reads a public WSDL fixture, resolved relative to the repo root vitest runs from. */
function readPublicFixture(name: string): string {
  return readFileSync(`${process.cwd()}/fixtures/wsdl/public/${name}/service.wsdl`, 'utf-8');
}

/** A running local echo server plus its base URL and a way to shut it down. */
interface EchoServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * A minimal in-process HTTP server for this file's tests: `POST /soap` echoes the body
 * back immediately, `POST /delay/<ms>` waits `ms` before doing the same (so `request.cancel`
 * has something to abort). Kept local rather than the engine's own `test-soap-server` helper
 * because that helper's `fixtures.ts` companion resolves paths via `import.meta.url`, which
 * does not carry a `file:` scheme under this project's jsdom test environment.
 */
async function startEchoServer(): Promise<EchoServer> {
  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(req);
      const delayMatch = /^\/delay\/(\d+)$/.exec(url.pathname);
      if (delayMatch !== null) {
        await new Promise((resolve) => setTimeout(resolve, Number(delayMatch[1])));
      }
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml' });
      res.end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('EngineService', () => {
  let server: EchoServer;
  let service: EngineService;

  beforeEach(async () => {
    server = await startEchoServer();
    service = new EngineService();
  });

  afterEach(async () => {
    await server.close();
  });

  it('imports a definition, generates a request for one of its operations, then closes it', async () => {
    const progressEvents: string[] = [];
    const summary = await service.importDefinition(
      { source: { kind: 'text', text: readPublicFixture('calculator'), location: `${server.url}/service.wsdl` } },
      { onProgress: (event) => progressEvents.push(event.phase) },
    );

    expect(summary.operations.length).toBeGreaterThan(0);
    expect(progressEvents).toContain('fetch');
    expect(progressEvents).toContain('parse');
    expect(progressEvents).toContain('schema');
    expect(progressEvents).toContain('done');

    const addOp = summary.operations.find((op) => op.name === 'Add');
    if (addOp === undefined) throw new Error('fixture has no Add operation');

    const generated = service.generate({
      interfaceId: summary.id,
      bindingName: addOp.binding,
      operationName: addOp.name,
    });
    expect(generated.envelopeXml).toContain('Add');

    expect(service.close(summary.id)).toEqual({ closed: true });
    expect(service.close(summary.id)).toEqual({ closed: false });
    try {
      service.generate({ interfaceId: summary.id, bindingName: addOp.binding, operationName: addOp.name });
      expect.unreachable('expected generate() to throw for a closed interface');
    } catch (err) {
      expect(err).toBeInstanceOf(WirebenchError);
      expect((err as WirebenchError).code).toBe('unknown-interface');
    }
  });

  it('cancelling a pending send aborts it, surfacing an `aborted` HttpError through the IPC envelope', async () => {
    const wrapped = wrapHandler(channels.request.send, (request) => service.send(request));
    const sendId = 'send-cancel-1';

    const pending = wrapped({
      sendId,
      input: { endpoint: `${server.url}/delay/500`, envelopeXml: '<a/>', soapVersion: '1.1' as const },
    });

    // Give the request a tick to register before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.cancel(sendId)).toEqual({ cancelled: true });
    expect(service.cancel(sendId)).toEqual({ cancelled: false });

    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: 'aborted' } });
  });

  it('cancel is a no-op for an unknown sendId', () => {
    expect(service.cancel('does-not-exist')).toEqual({ cancelled: false });
  });

  it('sends a real SOAP request and returns a JSON-safe ExchangeSummary', async () => {
    const summary = await service.importDefinition({
      source: { kind: 'text', text: readPublicFixture('calculator'), location: `${server.url}/service.wsdl` },
    });
    const addOp = summary.operations.find((op) => op.name === 'Add');
    if (addOp === undefined) throw new Error('fixture has no Add operation');
    const generated = service.generate({
      interfaceId: summary.id,
      bindingName: addOp.binding,
      operationName: addOp.name,
    });

    const exchange = await service.send({
      sendId: 'send-1',
      input: {
        endpoint: `${server.url}/soap`,
        envelopeXml: generated.envelopeXml,
        soapVersion: generated.soapVersion,
        headers: generated.headers,
      },
    });

    expect(exchange.http.status).toBe(200);
    expect(() => void JSON.parse(JSON.stringify(exchange))).not.toThrow();
  });

  it('echoes the token through every importDefinition progress event, including all phases in order', async () => {
    const testToken = 'test-token-123';
    const progressEvents: EngineProgressEvent[] = [];
    await service.importDefinition(
      {
        token: testToken,
        source: { kind: 'text', text: readPublicFixture('calculator'), location: `${server.url}/service.wsdl` },
      },
      { onProgress: (event) => progressEvents.push(event) },
    );

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents).toContainEqual(expect.objectContaining({ phase: 'fetch', kind: 'import' }));
    expect(progressEvents).toContainEqual(expect.objectContaining({ phase: 'parse', kind: 'import' }));
    expect(progressEvents).toContainEqual(expect.objectContaining({ phase: 'schema', kind: 'import' }));
    expect(progressEvents).toContainEqual(expect.objectContaining({ phase: 'done', kind: 'import' }));

    // Verify all events have the token
    progressEvents.forEach((event) => {
      expect(event.token).toBe(testToken);
    });

    // Verify phases are in the expected order
    const phases = progressEvents.map((e) => e.phase);
    const fetchIdx = phases.indexOf('fetch');
    const parseIdx = phases.indexOf('parse');
    const schemaIdx = phases.indexOf('schema');
    const doneIdx = phases.indexOf('done');
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(fetchIdx);
    expect(schemaIdx).toBeGreaterThan(parseIdx);
    expect(doneIdx).toBeGreaterThan(schemaIdx);
  });
});
