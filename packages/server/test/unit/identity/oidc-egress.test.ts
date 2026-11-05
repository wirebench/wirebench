/**
 * A hosted tenant's IdP is reached under the egress rule (hosted edition spec §17.5, §22.12): its issuer cannot point
 * the server at loopback or, in hosted mode, a private range, whether by a literal address or a name.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { egressFetch } from '../../../src/identity/oidc.js';

const GET = { method: 'GET', headers: {}, body: undefined, redirect: 'manual', signal: undefined } as never;

describe('the IdP fetch under the egress rule', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"issuer":"x"}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it('refuses a loopback issuer, by literal and by name, under the hosted rule', async () => {
    const fetch = egressFetch({ denyPrivate: true });
    await expect(fetch(`http://127.0.0.1:${String(port)}/x`, GET)).rejects.toMatchObject({ code: 'egress-refused' });
    await expect(fetch(`http://localhost:${String(port)}/x`, GET)).rejects.toMatchObject({ code: 'egress-refused' });
    await expect(fetch('http://10.1.2.3:1/x', GET)).rejects.toMatchObject({ code: 'egress-refused' });
  });

  it('answers as fetch does when the rule lets it through', async () => {
    const res = await egressFetch('unchecked')(`http://127.0.0.1:${String(port)}/x`, GET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: 'x' });
  });
});
