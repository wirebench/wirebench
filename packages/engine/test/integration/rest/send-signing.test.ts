import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entry } from '../../../src/rest/model.js';
import { sendRest } from '../../../src/rest/send.js';
import type { RestSendInput } from '../../../src/rest/send.js';
import { verifyWebhook } from '../../../src/webhooks/signature.js';
import { startTestRestServer, type TestRestServer } from '../../helpers/test-rest-server.js';

let server: TestRestServer;
beforeAll(async () => {
  server = await startTestRestServer();
});
afterAll(async () => {
  await server.close();
});

const SECRET = 'abc123def456ghi789';
const BODY = '{"event":"order.created"}';

function input(
  extra: Partial<RestSendInput> & { readonly body?: string; readonly headers?: RestSendInput['request']['headers'] },
): RestSendInput {
  const { body, headers, ...rest } = extra;
  return {
    baseUrl: server.url,
    request: {
      method: body === undefined ? 'GET' : 'POST',
      url: '/echo',
      pathParams: [],
      query: [],
      headers: headers ?? [],
      body: body === undefined ? { kind: 'none' } : { kind: 'raw', language: 'json', text: body },
    },
    settings: { timeoutMs: 5_000, followRedirects: true },
    ...rest,
  };
}

interface Echo {
  readonly headers: Record<string, string>;
  readonly body: string;
}
const echo = (text: string): Echo => JSON.parse(text) as Echo;

describe('sendRest with sign (§5.2)', () => {
  it('signs the encoded body last, replacing a typed header of the same name', async () => {
    const exchange = await sendRest(
      input({
        body: BODY,
        headers: [entry('x-signature', 'stale')],
        sign: {
          scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature', prefix: 'sha256=' },
          secret: SECRET,
        },
      }),
    );
    const seen = echo(exchange.text);
    expect(seen.body).toBe(BODY);
    expect(seen.headers['x-signature']).toBe('sha256=e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab');
  });

  it('signs an absent body as zero bytes', async () => {
    const exchange = await sendRest(
      input({
        sign: { scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' }, secret: SECRET },
      }),
    );
    expect(echo(exchange.text).headers['x-signature']).toBe(
      '0651527d1590913395d9980a7ddfb12498b7a03d7641908edc2bf93fb11e600a',
    );
  });

  it('adds the three Standard Webhooks headers, which the receiver verifies', async () => {
    const exchange = await sendRest(
      input({
        body: BODY,
        sign: { scheme: { kind: 'standard', toleranceSec: 300 }, secret: 'whsec_YWJjMTIzZGVmNDU2Z2hpNzg5' },
      }),
    );
    const seen = echo(exchange.text);
    expect(seen.headers['webhook-id']).toMatch(/^msg_[0-9a-f]{32}$/);
    const pairs = Object.entries(seen.headers);
    expect(
      verifyWebhook({ kind: 'standard', toleranceSec: 300 }, SECRET, pairs, new TextEncoder().encode(seen.body)),
    ).toEqual({ verdict: 'verified' });
  });

  it('refuses to send with a bad whsec_ secret', async () => {
    await expect(
      sendRest(
        input({ body: BODY, sign: { scheme: { kind: 'standard', toleranceSec: 300 }, secret: 'whsec_not*base64' } }),
      ),
    ).rejects.toMatchObject({ code: 'webhook-signing-secret' });
  });
});
