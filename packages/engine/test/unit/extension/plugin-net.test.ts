import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPluginNet, isBlockedAddress, type PluginNetRecord } from '#core/extension/plugin/net';

let server: Server;
let origin: string;
const seen: { url: string; authorization?: string }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({
      url: request.url ?? '',
      ...(request.headers.authorization !== undefined ? { authorization: request.headers.authorization } : {}),
    });
    if (request.url === '/hop') {
      response.writeHead(302, { location: '/schema' }).end();
      return;
    }
    if (request.url === '/away') {
      response.writeHead(302, { location: 'http://127.0.0.2:1/elsewhere' }).end();
      return;
    }
    if (request.url === '/loop') {
      response.writeHead(302, { location: '/loop' }).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end('schema text');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const ask = async (fetch: (text: string) => Promise<{ ok: boolean; text: string }>, request: unknown) => {
  const answer = await fetch(JSON.stringify(request));
  return answer.ok ? { ok: true, value: JSON.parse(answer.text) as { status: number; body: string } } : answer;
};

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['192.168.1.1', true],
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['93.184.216.34', false],
    ['2606:2800:220:1::248', false],
  ])('%s is blocked: %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });
});

describe('the plugin network broker', () => {
  it('sends to a listed origin, follows a same-origin redirect itself, and records without secrets', async () => {
    const records: PluginNetRecord[] = [];
    const net = createPluginNet({ plugin: 'acme', origins: [origin], record: (entry) => records.push(entry) });
    const result = await ask(net.forCall(), {
      url: `${origin}/hop`,
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(result).toEqual({
      ok: true,
      value: { status: 200, headers: expect.any(Object) as unknown, body: 'schema text' },
    });
    expect(seen.slice(-2)).toEqual([
      { url: '/hop', authorization: 'Bearer s3cret' },
      { url: '/schema', authorization: 'Bearer s3cret' },
    ]);
    expect(records.map((record) => [record.url, record.status])).toEqual([
      [`${origin}/hop`, 302],
      [`${origin}/schema`, 200],
    ]);
    expect(JSON.stringify(records)).not.toContain('s3cret');
  });

  it('refuses an origin the manifest does not list, before anything is sent', async () => {
    const before = seen.length;
    const net = createPluginNet({ plugin: 'acme', origins: ['https://schemas.example.test'] });
    expect(await ask(net.forCall(), { url: `${origin}/schema` })).toEqual({
      ok: false,
      text: `acme may not reach ${origin}: its manifest does not list it`,
    });
    expect(seen.length).toBe(before);
  });

  it('refuses a redirect to an origin it does not list', async () => {
    const net = createPluginNet({ plugin: 'acme', origins: [origin] });
    expect(await ask(net.forCall(), { url: `${origin}/away` })).toMatchObject({
      ok: false,
      text: 'acme may not reach http://127.0.0.2:1: its manifest does not list it',
    });
  });

  it('refuses a listed name that resolves to a private address', async () => {
    const net = createPluginNet({
      plugin: 'acme',
      origins: ['http://schemas.example.test'],
      resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(await ask(net.forCall(), { url: 'http://schemas.example.test/a' })).toEqual({
      ok: false,
      text: 'acme may not reach schemas.example.test: it resolves to a private or local address',
    });
  });

  it('stops a redirect loop, and a call past its request budget', async () => {
    const net = createPluginNet({ plugin: 'acme', origins: [origin] });
    expect(await ask(net.forCall(), { url: `${origin}/loop` })).toMatchObject({
      ok: false,
      text: expect.stringContaining('redirected more than 5 times') as unknown,
    });
    const fetch = net.forCall();
    for (let i = 0; i < 32; i += 1) await fetch(JSON.stringify({ url: `${origin}/schema` }));
    expect(await ask(fetch, { url: `${origin}/schema` })).toMatchObject({
      ok: false,
      text: expect.stringContaining('more than 32 requests') as unknown,
    });
    expect(await ask(net.forCall(), { url: `${origin}/schema` })).toMatchObject({ ok: true });
  });

  it('refuses a request it cannot read', async () => {
    const net = createPluginNet({ plugin: 'acme', origins: [origin] });
    expect(await ask(net.forCall(), { url: `${origin}/schema`, method: 'TRACE' })).toMatchObject({ ok: false });
    expect(await ask(net.forCall(), { url: `${origin}/schema`, headers: { a: 'x\r\nInjected: 1' } })).toMatchObject({
      ok: false,
    });
    expect(await ask(net.forCall(), { url: 'not a url' })).toMatchObject({ ok: false });
  });
});
