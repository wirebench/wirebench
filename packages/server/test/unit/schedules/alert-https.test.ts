import { createHmac } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ALERT_DEADLINE_MS, postAlert } from '../../../src/schedules/alerts/https.js';
import {
  generateServerCert,
  generateTestCa,
  type TestCertificate,
} from '../../../../engine/test/helpers/test-certs.js';
import { httpReceiver, type HttpReceiver } from '../../helpers/forward-receivers.js';

const BODY = { event: 'schedule.alert', version: 1, name: 'Zürich ✓' };

describe('alert delivery over HTTPS (scheduled-runs spec §3.4)', () => {
  let ca: TestCertificate;
  let identity: TestCertificate;
  beforeAll(() => {
    ca = generateTestCa();
    identity = generateServerCert(ca);
  });
  const receivers: HttpReceiver[] = [];
  afterEach(async () => {
    for (const receiver of receivers.splice(0)) await receiver.close();
  });
  const receiver = async (answer?: (res: ServerResponse) => void): Promise<HttpReceiver> => {
    const r = await httpReceiver(answer, identity);
    receivers.push(r);
    return r;
  };
  const failure = (promise: Promise<void>): Promise<Error | undefined> =>
    promise.then(
      () => undefined,
      (error: unknown) => error as Error,
    );

  it('POSTs the JSON body, unsigned without a secret', async () => {
    const r = await receiver();
    await postAlert({ url: `https://localhost:${r.port}/hook?k=v`, body: BODY }, { ca: ca.certPem });
    expect(r.requests).toHaveLength(1);
    const [request] = r.requests;
    expect(request).toMatchObject({ method: 'POST', url: '/hook?k=v' });
    expect(request!.headers['content-type']).toBe('application/json');
    expect(request!.headers['x-wirebench-signature']).toBeUndefined();
    expect(JSON.parse(request!.body)).toEqual(BODY);
  });

  it('signs the exact body bytes with HMAC-SHA256 when a secret is set', async () => {
    const r = await receiver();
    await postAlert({ url: `https://localhost:${r.port}/`, body: BODY, secret: 'shh' }, { ca: ca.certPem });
    const [request] = r.requests;
    const expected = createHmac('sha256', 'shh').update(request!.body, 'utf8').digest('hex');
    expect(request!.headers['x-wirebench-signature']).toBe(`sha256=${expected}`);
  });

  it('refuses http:// and a host off the allow-list without sending', async () => {
    const r = await receiver();
    await expect(postAlert({ url: `http://localhost:${r.port}/`, body: BODY })).rejects.toThrow(
      'the alert URL for localhost is not https://',
    );
    await expect(
      postAlert({ url: `https://localhost:${r.port}/`, body: BODY }, { ca: ca.certPem, alertHosts: ['*.example.com'] }),
    ).rejects.toThrow('alerts may not be sent to localhost on this server');
    expect(r.requests).toHaveLength(0);
    await postAlert({ url: `https://localhost:${r.port}/`, body: BODY }, { ca: ca.certPem, alertHosts: ['localhost'] });
    expect(r.requests).toHaveLength(1);
  });

  it('a non-2xx fails with the host and status, never the URL or the response body', async () => {
    const r = await receiver((res) => res.writeHead(403).end('invalid_token body-marker'));
    const error = await failure(
      postAlert({ url: `https://localhost:${r.port}/services/T0/B0/XYZSECRET`, body: BODY }, { ca: ca.certPem }),
    );
    expect(error?.message).toBe('the alert to localhost was answered 403');
  });

  it('does not follow a redirect', async () => {
    const target = await receiver();
    const r = await receiver((res) => res.writeHead(302, { location: `https://localhost:${target.port}/` }).end());
    await expect(postAlert({ url: `https://localhost:${r.port}/`, body: BODY }, { ca: ca.certPem })).rejects.toThrow(
      'the alert to localhost was answered 302; redirects are not followed',
    );
    expect(target.requests).toHaveLength(0);
  });

  it('gives up at the deadline, including on a response that trickles', async () => {
    expect(ALERT_DEADLINE_MS).toBe(10_000);
    const silent = await receiver(() => undefined);
    await expect(
      postAlert({ url: `https://localhost:${silent.port}/`, body: BODY }, { ca: ca.certPem, timeoutMs: 200 }),
    ).rejects.toThrow('the alert to localhost did not finish within 200 ms');
    const trickle = await receiver((res) => {
      res.writeHead(200);
      res.write('partial');
    });
    await expect(
      postAlert({ url: `https://localhost:${trickle.port}/`, body: BODY }, { ca: ca.certPem, timeoutMs: 200 }),
    ).rejects.toThrow(/did not finish within 200 ms/);
  });

  it('verifies the certificate: a server no root vouches for is refused', async () => {
    const r = await receiver();
    const error = await failure(postAlert({ url: `https://localhost:${r.port}/`, body: BODY }));
    expect(error?.message).toMatch(/^the alert to localhost failed: /);
    expect(r.requests).toHaveLength(0);
  });
});
