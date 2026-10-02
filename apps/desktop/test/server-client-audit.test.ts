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

  it('streamAuditExport hands each chunk to the sink and resolves at the end', async () => {
    const chunks: string[] = [];
    const client = new ServerClient({
      send: (req) => {
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
