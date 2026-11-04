/**
 * Slice 5 Task 13 (hosted edition spec §20.8, owner ruling 1): no telemetry by default. Without an OTLP endpoint the
 * SDK, the resources and the exporter are never imported and nothing is sent; with one, the numbers go over OTLP/HTTP
 * to it, named by the process's holder, and a shutdown flushes them. Its own file: the import spies must see every
 * import of the three packages, and no other test file here loads them first.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { metricsEndpointSet, startMetrics } from '../../../src/operations/metrics/sdk.js';

const imported = vi.hoisted(() => new Set<string>());

vi.mock('@opentelemetry/sdk-metrics', async (original) => {
  imported.add('sdk-metrics');
  return original();
});
vi.mock('@opentelemetry/resources', async (original) => {
  imported.add('resources');
  return original();
});
vi.mock('@opentelemetry/exporter-metrics-otlp-http', async (original) => {
  imported.add('exporter');
  return original();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A collector that keeps every request's path and JSON body. */
async function collector(): Promise<{
  url: string;
  received: { path: string; body: string }[];
  close(): Promise<void>;
}> {
  const received: { path: string; body: string }[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('the metrics SDK (spec §20.8)', () => {
  it('starts only for one of the two endpoint variables', () => {
    expect(metricsEndpointSet({})).toBe(false);
    expect(metricsEndpointSet({ OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBe(false);
    expect(metricsEndpointSet({ OTEL_EXPORTER_OTLP_HEADERS: 'a=b', OTEL_SERVICE_NAME: 'x' })).toBe(false);
    expect(metricsEndpointSet({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true);
    expect(metricsEndpointSet({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://collector:4318/v1/metrics' })).toBe(true);
  });

  it('without an endpoint, never imports the SDK and sends nothing', async () => {
    const otlp = await collector();
    try {
      // Every other OTEL_* variable set, and still no endpoint: nothing starts.
      const env = { OTEL_SERVICE_NAME: 'acme', OTEL_METRIC_EXPORT_INTERVAL: '10' };
      const handle = await startMetrics(env, { holder: randomUUID(), version: '1.0.0' });
      expect(handle.exporting).toBe(false);
      handle.metrics.send(randomUUID(), 'ok');
      handle.metrics.observe('instances', () => {
        throw new Error('a source is never read with metrics off');
      });
      await new Promise((done) => setTimeout(done, 50));
      await handle.shutdown();
      expect(imported).toEqual(new Set());
      expect(otlp.received).toEqual([]);
    } finally {
      await otlp.close();
    }
  });

  it('with an endpoint, exports over OTLP/HTTP named by the holder, and flushes on shutdown', async () => {
    const otlp = await collector();
    try {
      const holder = randomUUID();
      const tenantId = randomUUID();
      // The exporter reads the endpoint from `process.env`, as in production.
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', otlp.url);
      const handle = await startMetrics(process.env, { holder, version: '1.2.3' });
      expect(handle.exporting).toBe(true);
      expect(imported).toEqual(new Set(['sdk-metrics', 'resources', 'exporter']));
      handle.metrics.send(tenantId, 'ok');
      await handle.shutdown(5_000);
      expect(otlp.received.length).toBeGreaterThan(0);
      const { path, body } = otlp.received[0]!;
      expect(path).toBe('/v1/metrics');
      expect(body).toContain(holder);
      expect(body).toContain('wirebench-server');
      expect(body).toContain('wirebench.sends');
      expect(body).toContain(tenantId);
      // Idempotent: a second shutdown sends nothing more.
      const count = otlp.received.length;
      await handle.shutdown();
      expect(otlp.received).toHaveLength(count);
    } finally {
      await otlp.close();
    }
  });
});
