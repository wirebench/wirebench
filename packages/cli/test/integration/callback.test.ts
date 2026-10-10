/**
 * `wirebench run` with a callback assertion (callback-assertion §4, §6). One local server plays both
 * sides: the API under test, whose `POST /orders` calls back before it answers, and the Wirebench
 * Server, which keeps the callback and serves it only to the CI token. The token never appears in
 * anything the run prints or writes.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi, createProject, createRestRequest, saveProject } from '@wirebench/engine';
import type { CallbackAssertion } from '@wirebench/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './helpers.js';

const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const WRONG = 'wbs_zzz999yyy888xxx777zzz999yyy888xxx777zzz9999';
/** A token the server refuses with a message that quotes it back. */
const ECHOED = 'wbs_echo55echo66echo77echo55echo66echo77echo5555';
const WS = '01K000000000000000000000W1';
const HOOK = '01K000000000000000000000H1';
const HOOKS = `/api/v1/workspaces/${WS}/hooks`;

interface Stored {
  readonly id: string;
  readonly body: string;
}
const captures: Stored[] = [];
let origin = '';
let close: () => Promise<void>;
let dir: string;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const summaryOf = (c: Stored) => ({
  id: c.id,
  receivedAt: '2026-09-29T10:00:00.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: c.body.length,
  truncated: false,
  sourceIp: '127.0.0.1',
  signature: null,
});

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? '/', origin);
  if (req.method === 'POST' && url.pathname === '/orders') {
    // The API under test: it calls back before it answers.
    const status = body.includes('refuse') ? 'failed' : 'paid';
    captures.push({
      id: `01K${String(captures.length + 1).padStart(23, '0')}`,
      body: JSON.stringify({ orderId: 'A-17', status }),
    });
    json(res, 201, { orderId: 'A-17' });
    return;
  }
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (bearer === ECHOED) {
    json(res, 401, { code: 'identity-unauthenticated', message: `Token ${bearer} is not valid.` });
    return;
  }
  if (bearer !== TOKEN) {
    json(res, 401, { code: 'identity-unauthenticated', message: 'Sign in to continue.' });
    return;
  }
  if (url.pathname === '/api/v1/ci/whoami') {
    json(res, 200, { workspaceId: WS, workspaceName: 'Integration', tokenName: 'pipeline-main' });
    return;
  }
  if (url.pathname === HOOKS) {
    json(res, 200, [
      {
        id: HOOK,
        workspaceId: WS,
        name: 'orders-hook',
        enabled: true,
        response: { status: 200, contentType: null, body: null, delayMs: 0 },
        captureCount: captures.length,
        newestCaptureId: captures.at(-1)?.id ?? null,
        createdAt: '2026-09-29T10:00:00.000Z',
      },
    ]);
    return;
  }
  if (url.pathname === `${HOOKS}/${HOOK}/captures`) {
    const after = url.searchParams.get('after');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const page =
      after !== null
        ? captures
            .filter((c) => c.id > after)
            .slice(0, limit)
            .reverse()
        : [...captures].reverse().slice(0, limit);
    json(res, 200, page.map(summaryOf));
    return;
  }
  const detail = captures.find((c) => url.pathname === `${HOOKS}/${HOOK}/captures/${c.id}`);
  if (detail !== undefined) {
    json(res, 200, {
      ...summaryOf(detail),
      query: '',
      headers: [['Content-Type', 'application/json']],
      body: Buffer.from(detail.body).toString('base64'),
    });
    return;
  }
  json(res, 404, { code: 'not-found', message: 'Not found.' });
}

const CALLBACK: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 5_000,
  match: { method: 'POST', path: '/events' },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }],
};

beforeAll(async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  dir = await mkdtemp(join(tmpdir(), 'wb-cli-callback-'));
  const order = (id: string, name: string, text: string) => ({
    ...createRestRequest(name, { id, method: 'POST', url: '/orders', body: { kind: 'raw', language: 'json', text } }),
    assertions: [CALLBACK],
  });
  await saveProject(
    {
      ...createProject('Shop', { id: 'P1' }),
      containers: {
        rest: [
          createApi('Shop', {
            id: 'A1',
            baseUrl: origin,
            requests: [order('R1', 'Pay', '{"outcome":"pay"}'), order('R2', 'Refuse', '{"outcome":"refuse"}')],
          }),
        ],
      },
    },
    dir,
  );
});

afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe('wirebench run with a callback assertion', () => {
  it('passes when the callback arrives and holds, and never prints or writes the token', async () => {
    const report = join(dir, 'report.json');
    const { code, stdout, stderr } = await runCli(
      ['run', dir, 'Shop/Pay', '-v', '--reporter', 'cli', '--reporter', `json=${report}`],
      { WIREBENCH_SERVER_URL: origin, WIREBENCH_SERVER_TOKEN: TOKEN },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/✓ callback orders-hook — matched capture 01K\d{23} after \d+(\.\d)? s/);
    const written = await readFile(report, 'utf8');
    const parsed = JSON.parse(written) as { requests: { assertions: unknown[] }[] };
    expect(parsed.requests[0]?.assertions[0]).toMatchObject({
      type: 'callback',
      outcome: 'passed',
      capture: { hookId: HOOK },
    });
    expect(stdout + stderr + written).not.toContain(TOKEN);
  });

  it('fails a check on the matched capture', async () => {
    const { code, stdout } = await runCli(['run', dir, 'Shop/Refuse'], {
      WIREBENCH_SERVER_URL: origin,
      WIREBENCH_SERVER_TOKEN: TOKEN,
    });
    expect(code).toBe(1);
    expect(stdout).toMatch(/callback orders-hook — matched 01K\d{23}, but \$\.status: expected "paid", got "failed"/);
  });

  it('errors the callback, not the run, without the variables; the request is still sent', async () => {
    const before = captures.length;
    const junit = join(dir, 'junit.xml');
    const { code, stdout } = await runCli(
      ['run', dir, 'Shop/Pay', '--reporter', 'cli', '--reporter', `junit=${junit}`],
      { WIREBENCH_SERVER_URL: '', WIREBENCH_SERVER_TOKEN: '' },
    );
    expect(code).toBe(3);
    expect(captures.length).toBe(before + 1);
    expect(stdout).toContain(
      'callback orders-hook — set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks',
    );
    expect(await readFile(junit, 'utf8')).toContain('<error type="callback"');
  });

  it('errors with the server’s answer, and without the token, when the token is refused', async () => {
    const { code, stdout, stderr } = await runCli(['run', dir, 'Shop/Pay'], {
      WIREBENCH_SERVER_URL: origin,
      WIREBENCH_SERVER_TOKEN: WRONG,
    });
    expect(code).toBe(3);
    expect(stdout).toContain(`${origin} answered 401 identity-unauthenticated: Sign in to continue.`);
    expect(stdout + stderr).not.toContain(WRONG);
  });

  it('masks the token when the server’s own message quotes it back', async () => {
    const { code, stdout, stderr } = await runCli(['run', dir, 'Shop/Pay'], {
      WIREBENCH_SERVER_URL: origin,
      WIREBENCH_SERVER_TOKEN: ECHOED,
    });
    expect(code).toBe(3);
    // The server's message is on screen (so the masking is not vacuous), with the token replaced.
    expect(stdout).toMatch(/answered 401 identity-unauthenticated: Token \S+ is not valid\./);
    expect(stdout + stderr).not.toContain(ECHOED);
  });
});
