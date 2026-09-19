import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';

/**
 * The built bin, not `src/bin.ts`: the engine's source imports its siblings with `.js`
 * specifiers, which Node's type stripping does not rewrite. `global-setup.ts` builds it once.
 */
const BIN = join(import.meta.dirname, '..', '..', 'dist', 'bin.js');
export const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'runner-project');

/** Runs the built CLI as a child process. */
export function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export interface DemoServer {
  readonly url: string;
  /** Paths of every request received, in order. */
  readonly requests: string[];
  /** The `Authorization` header of every request to `/secure`, in order. */
  readonly secureAuth: (string | undefined)[];
  close(): Promise<void>;
}

/**
 * The fixture's REST API: `/ok`, `/slow` (200 ms late), `/broken` (500) and `/secure` (Basic
 * `svc:hunter2-long`, else 401). The engine's test
 * server has no per-route delay, and this is small enough not to be worth adding one there.
 */
export async function startDemoServer(): Promise<DemoServer> {
  const requests: string[] = [];
  const secureAuth: (string | undefined)[] = [];
  const expected = `Basic ${Buffer.from('svc:hunter2-long').toString('base64')}`;
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    requests.push(path);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/ok') {
      json(200, { ok: true });
    } else if (path === '/slow') {
      setTimeout(() => json(200, { ok: true }), 200);
    } else if (path === '/broken') {
      json(500, { ok: false });
    } else if (path === '/secure') {
      secureAuth.push(req.headers.authorization);
      json(req.headers.authorization === expected ? 200 : 401, {});
    } else {
      json(404, {});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    secureAuth,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** Every file below `dir`, relative path → SHA-256, to prove a run wrote nothing there. */
export async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const full = join(entry.parentPath, entry.name);
      out[relative(dir, full)] = createHash('sha256')
        .update(await readFile(full))
        .digest('hex');
    }
  }
  return out;
}
