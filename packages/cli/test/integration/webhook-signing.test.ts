import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProject, createRestRequest, createWebhookCollection, saveProject } from '@wirebench/engine';
import { runCli } from './helpers.js';

const BODY = '{"event":"order.created"}';
/** HMAC-SHA256 hex of BODY under abc123def456ghi789 (the plan's known-answer table). */
const EXPECTED = 'e4d262af7821275e8ec7f51f7999a4a239fa3ee155f413fd980c39c4ed5864ab';

let dir: string;
let receiverUrl: string;
let close: () => Promise<void>;
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
  dir = await mkdtemp(join(tmpdir(), 'wb-cli-signing-'));
  await saveProject(
    {
      ...createProject('Hooks', { id: 'p1' }),
      webhooks: createWebhookCollection({
        target: receiverUrl,
        signing: {
          mode: 'sign',
          scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
          secretEnv: 'HOOKS_SIGNING',
        },
        requests: [
          createRestRequest('Ping', {
            id: 'w1',
            slug: 'ping',
            method: 'POST',
            url: '/ping',
            body: { kind: 'raw', language: 'json', text: BODY },
          }),
        ],
      }),
    },
    dir,
  );
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  received.length = 0;
});

describe('wirebench run signs webhook items (§5.2)', () => {
  it('signs the bytes it sends with the secret from WIREBENCH_SECRET_<secretEnv>', async () => {
    const { code, stdout } = await runCli(['run', dir, 'Webhooks/Ping'], {
      WIREBENCH_SECRET_HOOKS_SIGNING: 'abc123def456ghi789',
    });
    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.body).toBe(BODY);
    expect(received[0]?.headers['x-signature']).toBe(EXPECTED);
    expect(stdout).not.toContain('abc123def456ghi789');
  });

  it('exits 3 naming the variable, and sends nothing, without the secret', async () => {
    const { code, stdout, stderr } = await runCli(['run', dir, 'Webhooks/Ping'], {});
    expect(code).toBe(3);
    expect(stdout + stderr).toContain('Set WIREBENCH_SECRET_HOOKS_SIGNING to run "Webhooks/Ping".');
    expect(received).toHaveLength(0);
  });
});
