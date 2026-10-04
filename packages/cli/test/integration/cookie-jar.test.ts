import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApi, createProject, createRestRequest, saveProject } from '@wirebench/engine';
import { runCli } from './helpers.js';

let dir: string;
let close: () => Promise<void>;
/** The `Cookie` header of every request but the login, in order. */
const seen: (string | null)[] = [];

beforeAll(async () => {
  const server = createServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=run-cookie; Path=/' });
      res.end('{}');
      return;
    }
    seen.push(req.headers.cookie ?? null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
  dir = await mkdtemp(join(tmpdir(), 'wb-cli-jar-'));
  await saveProject(
    {
      ...createProject('Jar', { id: 'p-jar' }),
      apis: [
        {
          ...createApi('Api', { id: 'api-1', slug: 'api', baseUrl: base }),
          requests: [
            createRestRequest('Login', { id: 'r1', slug: 'login', order: 0, url: '/login' }),
            createRestRequest('Me', { id: 'r2', slug: 'me', order: 1, url: '/me', settings: { sendCookies: true } }),
            createRestRequest('Anon', { id: 'r3', slug: 'anon', order: 2, url: '/anon' }),
          ],
        },
      ],
    },
    dir,
  );
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
});

describe('wirebench run keeps one cookie jar per run (cookie jar spec §4)', () => {
  it('carries a cookie an earlier request received, only where Send cookies is on', async () => {
    const { code } = await runCli(['run', dir, 'Api/Login', 'Api/Me', 'Api/Anon'], {});
    expect(code).toBe(0);
    expect(seen).toEqual(['sid=run-cookie', null]);
  });

  it('keeps nothing from one run to the next', async () => {
    const { code } = await runCli(['run', dir, 'Api/Me'], {});
    expect(code).toBe(0);
    expect(seen).toEqual([null]);
  });
});
