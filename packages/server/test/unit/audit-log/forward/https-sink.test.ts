import { afterEach, describe, expect, it } from 'vitest';
import { HttpsSink } from '../../../../src/audit-log/forward/https-sink.js';
import {
  generateSecondTestCa,
  generateServerCert,
  generateTestCa,
} from '../../../../../engine/test/helpers/test-certs.js';
import { httpReceiver } from '../../../helpers/forward-receivers.js';
import { freePort } from '../../../helpers/net.js';
import { auditEvent } from './fixtures.js';

const TOKEN = 'tok-very-secret-123';

describe('HttpsSink', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });
  const track = <T extends { close(): Promise<void> }>(thing: T): T => {
    cleanup.push(() => thing.close());
    return thing;
  };

  it('POSTs the batch as JSON with the bearer token', async () => {
    const receiver = track(await httpReceiver());
    const sink = track(
      new HttpsSink({ url: `http://127.0.0.1:${receiver.port}/ingest?x=1`, token: TOKEN, timeoutMs: 500 }),
    );
    const events = [auditEvent({ id: 'e1' }), auditEvent({ id: 'e2', details: { name: 'Zürich ✓' } })];
    await sink.send(events);
    expect(receiver.requests).toHaveLength(1);
    const [request] = receiver.requests;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe('/ingest?x=1');
    expect(request!.headers['content-type']).toBe('application/json');
    expect(request!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(request!.body)).toEqual({ events });
  });

  it('sends no authorization header without a token', async () => {
    const receiver = track(await httpReceiver());
    const sink = track(new HttpsSink({ url: `http://127.0.0.1:${receiver.port}/`, timeoutMs: 500 }));
    await sink.send([auditEvent()]);
    expect(receiver.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('accepts any 2xx', async () => {
    const receiver = track(await httpReceiver((res) => res.writeHead(202).end('queued')));
    const sink = track(new HttpsSink({ url: `http://127.0.0.1:${receiver.port}/`, timeoutMs: 500 }));
    await expect(sink.send([auditEvent()])).resolves.toBeUndefined();
  });

  it('rejects a 500 with the status and host, never the token or the body', async () => {
    const receiver = track(await httpReceiver((res) => res.writeHead(500).end(`boom ${TOKEN} response-body-marker`)));
    const sink = track(new HttpsSink({ url: `http://127.0.0.1:${receiver.port}/`, token: TOKEN, timeoutMs: 500 }));
    const error = await sink.send([auditEvent()]).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/500/);
    expect(error?.message).toMatch(/127\.0\.0\.1/);
    expect(error?.message).not.toContain(TOKEN);
    expect(error?.message).not.toContain('response-body-marker');
  });

  it('does not follow a redirect', async () => {
    const target = track(await httpReceiver());
    const receiver = track(
      await httpReceiver((res) => res.writeHead(307, { location: `http://127.0.0.1:${target.port}/` }).end()),
    );
    const sink = track(new HttpsSink({ url: `http://127.0.0.1:${receiver.port}/`, token: TOKEN, timeoutMs: 500 }));
    await expect(sink.send([auditEvent()])).rejects.toThrow(/307/);
    expect(target.requests).toHaveLength(0);
  });

  it('rejects when the endpoint hangs past the timeout', async () => {
    const receiver = track(await httpReceiver(() => undefined));
    const sink = track(new HttpsSink({ url: `http://127.0.0.1:${receiver.port}/`, timeoutMs: 200 }));
    const started = Date.now();
    await expect(sink.send([auditEvent()])).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects when a response body trickles past the timeout', async () => {
    const receiver = track(
      await httpReceiver((res) => {
        res.writeHead(200);
        res.write('partial');
      }),
    );
    const sink = track(new HttpsSink({ url: `http://127.0.0.1:${receiver.port}/`, timeoutMs: 200 }));
    await expect(sink.send([auditEvent()])).rejects.toThrow(/timed out/);
  });

  it('rejects when nothing listens on the port', async () => {
    const sink = track(new HttpsSink({ url: `http://127.0.0.1:${await freePort()}/`, token: TOKEN, timeoutMs: 500 }));
    const error = await sink.send([auditEvent()]).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/127\.0\.0\.1/);
    expect(error?.message).not.toContain(TOKEN);
  });

  it('verifies an HTTPS server against the CA it is given, added to the system roots', async () => {
    const ca = generateTestCa();
    const receiver = track(await httpReceiver(undefined, generateServerCert(ca)));
    const sink = track(
      new HttpsSink({ url: `https://localhost:${receiver.port}/`, token: TOKEN, ca: ca.certPem, timeoutMs: 2_000 }),
    );
    await sink.send([auditEvent()]);
    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses an HTTPS server the CA does not vouch for, and one with no CA given', async () => {
    const receiver = track(await httpReceiver(undefined, generateServerCert(generateTestCa())));
    const url = `https://localhost:${receiver.port}/`;
    const wrong = track(new HttpsSink({ url, ca: generateSecondTestCa().certPem, timeoutMs: 2_000 }));
    await expect(wrong.send([auditEvent()])).rejects.toThrow(/localhost/);
    const none = track(new HttpsSink({ url, timeoutMs: 2_000 }));
    await expect(none.send([auditEvent()])).rejects.toThrow(/localhost/);
    expect(receiver.requests).toHaveLength(0);
  });

  it('sends nothing for an empty batch', async () => {
    const receiver = track(await httpReceiver());
    const sink = track(new HttpsSink({ url: `http://127.0.0.1:${receiver.port}/`, timeoutMs: 500 }));
    await sink.send([]);
    expect(receiver.requests).toHaveLength(0);
  });
});
