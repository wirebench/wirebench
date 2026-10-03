import { describe, expect, it } from 'vitest';
import { ServerClient } from '../src/main/server-client.js';

const json = (status: number, body: unknown) =>
  ({
    status,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  }) as never;

describe('ServerClient audit (audit-log spec §3.4, plan ruling 16)', () => {
  it('queryAudit builds the query string and parses the page', async () => {
    const seen: string[] = [];
    const client = new ServerClient({
      send: (req) => {
        seen.push(req.url);
        return Promise.resolve(json(200, { events: [], next: 'c1' }));
      },
    });
    const page = await client.queryAudit('https://s.example', 'tok', { action: 'auth.', limit: 10, after: 'c0' });
    expect(seen[0]).toBe('https://s.example/api/v1/audit?action=auth.&after=c0&limit=10');
    expect(page.next).toBe('c1');
  });

  it('queryAudit and streamAuditExport carry teamId on the query string', async () => {
    const seen: string[] = [];
    const client = new ServerClient({
      send: (req) => {
        seen.push(req.url);
        if (req.stream) req.stream.accept(200, {});
        return Promise.resolve({
          status: 200,
          headers: {},
          body: new TextEncoder().encode('{"events":[]}'),
          streamEnd: { by: 'server' },
        } as never);
      },
    });
    await client.streamAuditExport('https://s.example', 'tok', { teamId: 'T1' }, () => () => undefined);
    expect(seen[0]).toBe('https://s.example/api/v1/audit/export?teamId=T1');
    seen.length = 0;
    const c2 = new ServerClient({
      send: (req) => {
        seen.push(req.url);
        return Promise.resolve(json(200, { events: [] }));
      },
    });
    await c2.queryAudit('https://s.example', 'tok', { teamId: 'T1', limit: 5 });
    expect(seen[0]).toBe('https://s.example/api/v1/audit?limit=5&teamId=T1');
  });

  it('streamAuditExport hands each chunk to the sink and resolves at the end', async () => {
    const chunks: string[] = [];
    const requests: { headers: Record<string, string>; followRedirects?: boolean }[] = [];
    const client = new ServerClient({
      send: (req) => {
        requests.push(req);
        const sink = req.stream!.accept(200, { 'content-type': 'application/x-ndjson' })!;
        sink.onChunk(new TextEncoder().encode('{"a":1}\n'));
        sink.onChunk(new TextEncoder().encode('{"a":2}\n'));
        return Promise.resolve({
          status: 200,
          headers: {},
          body: new Uint8Array(),
          streamEnd: { by: 'server' },
        } as never);
      },
    });
    await client.streamAuditExport(
      'https://s.example',
      'tok',
      {},
      () => (chunk) => chunks.push(new TextDecoder().decode(chunk)),
    );
    expect(chunks.join('')).toBe('{"a":1}\n{"a":2}\n');
    expect(requests[0]!.headers['authorization']).toBe('Bearer tok');
    expect(requests[0]!.headers['accept']).toBe('application/x-ndjson');
    expect(requests[0]!.followRedirects).toBe(false);
  });

  it('a stream that ends in an error rejects as server-unreachable', async () => {
    const client = new ServerClient({
      send: (req) => {
        req.stream!.accept(200, {})!.onChunk(new TextEncoder().encode('{"a":1}\n'));
        return Promise.resolve({
          status: 200,
          headers: {},
          body: new Uint8Array(),
          streamEnd: { by: 'error', error: 'reset' },
        } as never);
      },
    });
    await expect(client.streamAuditExport('https://s.example', 'tok', {}, () => () => undefined)).rejects.toMatchObject(
      {
        code: 'server-unreachable',
      },
    );
  });

  it("a problem status is not streamed, never opens the sink, and rejects with the server's code", async () => {
    const client = new ServerClient({
      send: (req) => {
        expect(req.stream!.accept(403, { 'content-type': 'application/json' })).toBeUndefined();
        return Promise.resolve(json(403, { code: 'licensing-feature-required', message: 'no' }));
      },
    });
    let opened = false;
    const open = () => {
      opened = true;
      return () => undefined;
    };
    await expect(client.streamAuditExport('https://s.example', 'tok', {}, open)).rejects.toMatchObject({
      code: 'licensing-feature-required',
    });
    expect(opened).toBe(false);
  });
});

describe('ServerClient reportDesktopEvents (desktop audit events spec §2.4)', () => {
  const batch = { events: [], dropped: 3 };

  it('POSTs the batch to the workspace route and resolves on 204', async () => {
    const seen: { url: string; method: string; body: string; auth: string | undefined }[] = [];
    const client = new ServerClient({
      send: (req) => {
        seen.push({
          url: req.url,
          method: req.method,
          body: new TextDecoder().decode(req.body),
          auth: req.headers['authorization'],
        });
        return Promise.resolve({ status: 204, headers: {}, body: new Uint8Array() } as never);
      },
    });
    await client.reportDesktopEvents('https://s.example', 'tok', 'w 1', batch);
    expect(seen[0]).toEqual({
      url: 'https://s.example/api/v1/workspaces/w%201/audit/desktop-events',
      method: 'POST',
      body: JSON.stringify(batch),
      auth: 'Bearer tok',
    });
  });

  it('raises a 409 as the server code', async () => {
    const client = new ServerClient({
      send: () => Promise.resolve(json(409, { code: 'audit-desktop-recording-off', message: 'Recording is off.' })),
    });
    await expect(client.reportDesktopEvents('https://s.example', 'tok', 'w1', batch)).rejects.toMatchObject({
      code: 'audit-desktop-recording-off',
    });
  });
});
