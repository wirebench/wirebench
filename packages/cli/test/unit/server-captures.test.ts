// packages/cli/test/unit/server-captures.test.ts
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { CAPTURES_UNSET_MESSAGE, captureSourceFromEnv } from '../../src/server-captures.js';

const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const ORIGIN = 'https://wb.example.test';
const WS = '01K000000000000000000000W1';
const HOOK = '01K000000000000000000000H1';
const CAP = '01K00000000000000000000002';
const HOOKS = `/api/v1/workspaces/${WS}/hooks`;

function exchange(status: number, body: unknown): HttpExchange {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
    httpVersion: '1.1',
    truncated: false,
  } as unknown as HttpExchange;
}

const summary = {
  id: CAP,
  receivedAt: '2026-09-29T10:00:00.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: 17,
  truncated: false,
  sourceIp: '127.0.0.1',
  signature: null,
};

function fakeServer(answers: Record<string, readonly [number, unknown]>) {
  const sent: HttpRequest[] = [];
  const send = (request: HttpRequest): Promise<HttpExchange> => {
    sent.push(request);
    const url = new URL(request.url);
    const answer = answers[`${url.pathname}${url.search}`] ??
      answers[url.pathname] ?? [404, { code: 'not-found', message: 'Not found.' }];
    return Promise.resolve(exchange(answer[0], answer[1]));
  };
  return { send, sent };
}

const HAPPY = {
  '/api/v1/ci/whoami': [200, { workspaceId: WS, workspaceName: 'Integration', tokenName: 'pipeline-main' }],
  [HOOKS]: [
    200,
    [
      {
        id: HOOK,
        workspaceId: WS,
        name: 'orders-hook',
        url: `${ORIGIN}/hooks/${'7'.repeat(26)}`,
        enabled: true,
        response: { status: 200, contentType: null, body: null, delayMs: 0 },
        captureCount: 1,
        newestCaptureId: CAP,
        createdAt: '2026-09-29T10:00:00.000Z',
      },
    ],
  ],
  [`${HOOKS}/${HOOK}/captures?limit=1`]: [200, [summary]],
  [`${HOOKS}/${HOOK}/captures?after=00000000000000000000000000&limit=200`]: [200, [summary]],
  [`${HOOKS}/${HOOK}/captures/${CAP}`]: [
    200,
    {
      ...summary,
      query: '',
      headers: [['X-Event', 'order.created']],
      body: Buffer.from('{"status":"paid"}').toString('base64'),
    },
  ],
} as const;

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('captureSourceFromEnv', () => {
  it('errors every callback, and carries no token, when either variable is unset or blank', async () => {
    for (const env of [
      {},
      { WIREBENCH_SERVER_URL: ORIGIN },
      { WIREBENCH_SERVER_TOKEN: TOKEN },
      { WIREBENCH_SERVER_URL: '', WIREBENCH_SERVER_TOKEN: TOKEN },
    ]) {
      const built = captureSourceFromEnv(env);
      await expect(built.source.resolve('orders-hook')).rejects.toMatchObject({ message: CAPTURES_UNSET_MESSAGE });
      if (env.WIREBENCH_SERVER_TOKEN === undefined) expect(built.token).toBeUndefined();
    }
  });

  it('asks whoami once, lazily, then reads hooks and captures with the token in one header', async () => {
    const server = fakeServer(HAPPY);
    const built = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: `${ORIGIN}/ignored/path`, WIREBENCH_SERVER_TOKEN: ` ${TOKEN} ` },
      { send: server.send },
    );
    expect(built.token).toBe(TOKEN);
    expect(server.sent).toHaveLength(0);
    const { source } = built;
    expect(await source.resolve('Orders-Hook')).toEqual({ hookId: HOOK });
    expect(await source.resolve('orders-hook')).toEqual({ hookId: HOOK });
    expect(await source.cursor(HOOK)).toBe(CAP);
    expect((await source.after(HOOK, null)).map((c) => c.path)).toEqual(['/events']);
    expect((await source.detail(HOOK, CAP)).bodyText).toBe('{"status":"paid"}');
    expect(server.sent.map((r) => new URL(r.url).pathname).filter((p) => p === '/api/v1/ci/whoami')).toHaveLength(1);
    for (const request of server.sent) {
      expect(request.url.startsWith(`${ORIGIN}/api/v1/`)).toBe(true);
      expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(request.followRedirects).toBe(false);
    }
  });

  it('turns a refusal or a network failure into a message without the token', async () => {
    const refused = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: ORIGIN, WIREBENCH_SERVER_TOKEN: TOKEN },
      {
        send: fakeServer({
          '/api/v1/ci/whoami': [401, { code: 'identity-unauthenticated', message: 'Sign in to continue.' }],
        }).send,
      },
    );
    const error = await rejection(refused.source.resolve('orders-hook'));
    expect(error.message).toBe(`${ORIGIN} answered 401 identity-unauthenticated: Sign in to continue.`);
    expect(error.message).not.toContain(TOKEN);

    const down = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: ORIGIN, WIREBENCH_SERVER_TOKEN: TOKEN },
      { send: () => Promise.reject(new Error(`connect ECONNREFUSED; Authorization: Bearer ${TOKEN}`)) },
    );
    const failure = await rejection(down.source.resolve('orders-hook'));
    expect(failure.message).toBe(`Could not reach ${ORIGIN}`);
  });

  it('needs only id and name of each hook: a CI token is never given the catch url', async () => {
    const bare = fakeServer({ ...HAPPY, [HOOKS]: [200, [{ id: HOOK, name: 'orders-hook' }]] });
    const built = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: ORIGIN, WIREBENCH_SERVER_TOKEN: TOKEN },
      { send: bare.send },
    );
    expect(await built.source.resolve('orders-hook')).toEqual({ hookId: HOOK });
    expect(await built.source.resolve('other')).toBeUndefined();
  });

  it('gives every read its own timeout of at most 10 s', async () => {
    const server = fakeServer(HAPPY);
    const built = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: ORIGIN, WIREBENCH_SERVER_TOKEN: TOKEN },
      { send: server.send },
    );
    await built.source.resolve('orders-hook');
    await built.source.cursor(HOOK);
    expect(server.sent.length).toBeGreaterThan(2);
    for (const request of server.sent) {
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(10_000);
    }
  });

  it('rejects an unexpected shape and a bad url without the token', async () => {
    const odd = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: ORIGIN, WIREBENCH_SERVER_TOKEN: TOKEN },
      { send: fakeServer({ '/api/v1/ci/whoami': [200, { nope: true }] }).send },
    );
    const error = await rejection(odd.source.resolve('x'));
    expect(error.message).toBe(`${ORIGIN} answered with an unexpected shape`);

    const bad = captureSourceFromEnv({ WIREBENCH_SERVER_URL: 'not a url', WIREBENCH_SERVER_TOKEN: TOKEN });
    const refused = await rejection(bad.source.resolve('x'));
    expect(refused.message).toBe('WIREBENCH_SERVER_URL is not a URL');
    expect(refused.message).not.toContain(TOKEN);
  });
});
