/**
 * `wirebench agent pair | status | unpair | allow-env` and the agent itself (hosted edition spec §18.6),
 * through the built bundle, against a fake server that checks every signature. `global-setup.ts` builds it.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_STATUS_FILE } from '../../src/agent/status-file.js';
import { main } from '../../src/main.js';
import { agentCommand } from '../../src/commands/agent.js';
import { startFakePairingServer, type FakePairingServer } from './agent-fake-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp(): Promise<{ readonly home: string; readonly server: FakePairingServer }> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-cli-agent-'));
  const server = await startFakePairingServer();
  cleanups.push(
    () => rm(dir, { recursive: true, force: true }),
    () => server.close(),
  );
  return { home: join(dir, 'agent'), server };
}

function capture(home: string, env: NodeJS.ProcessEnv = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  return {
    io: { stdout, stderr, env: { ...env, WIREBENCH_AGENT_HOME: home } },
    out: () => out,
    err: () => err,
  };
}

async function run(
  home: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = capture(home, env);
  const code = await main(['agent', ...argv], io.io);
  return { code, out: io.out(), err: io.err() };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('wirebench agent', () => {
  it('pairs, lists the pairing, and unpairs it at the server and here', async () => {
    const { home, server } = await setUp();
    const paired = await run(home, ['pair', server.code, '--server', server.url, '--ssh']);
    expect(paired).toMatchObject({ code: 0, err: '' });
    expect(paired.out).toContain(`Paired with ${server.url} as ${server.email}.`);
    expect(server.pairings.size).toBe(1);
    // No agent runs: the server is told the port the agent will take first.
    expect([...server.pairings.values()][0]?.port).toBe(47_615);

    const status = await run(home, ['status']);
    expect(status.code).toBe(0);
    expect(status.out).toContain('Agent: not running');
    expect(status.out).toContain(`${server.url}  ${server.email}`);
    expect(status.out).toContain('SSH allowed');
    expect(status.out).toContain('Allowed environment variables: none');

    const unpaired = await run(home, ['unpair', '--server', server.url]);
    expect(unpaired).toMatchObject({ code: 0, err: '' });
    expect(unpaired.out).toContain(`Unpaired from ${server.url}`);
    expect(server.pairings.size).toBe(0);
    expect(server.signed.at(-1)).toEqual({
      method: 'DELETE',
      path: expect.stringMatching(/^\/api\/v1\/agent\/pairings\//) as unknown,
      ok: true,
    });
    expect((await run(home, ['status'])).out).toContain('Pairings: none');
  });

  it('refuses a wrong code with the server’s answer, and keeps no pairing', async () => {
    const { home, server } = await setUp();
    const refused = await run(home, ['pair', 'WRONG2', '--server', server.url]);
    expect(refused.code).toBe(3);
    expect(refused.err).toMatch(/^wirebench agent: /);
    expect((await run(home, ['status'])).out).toContain('Pairings: none');
  });

  it('keeps the allowlist with the pairings: refused before the first, then round-trips', async () => {
    const { home, server } = await setUp();
    const early = await run(home, ['allow-env', 'API_TOKEN']);
    expect(early.code).toBe(2);
    expect(early.err).toContain('Pair this machine first');

    await run(home, ['pair', server.code, '--server', server.url]);
    expect((await run(home, ['allow-env', 'API_TOKEN', 'REGION'])).out).toContain(
      'Allowed environment variables: API_TOKEN, REGION',
    );
    expect((await run(home, ['allowed-env'])).out).toBe('API_TOKEN\nREGION\n');
    expect((await run(home, ['disallow-env', 'API_TOKEN'])).out).toContain('Allowed environment variables: REGION');
    const bad = await run(home, ['allow-env', 'not-a-name']);
    expect(bad.code).toBe(3);
    expect(bad.err).toContain('not-a-name is not an environment variable name');
    expect((await run(home, ['status'])).out).toContain('Allowed environment variables: REGION');
  });

  it('runs until stopped, says so in agent.json meanwhile, and a pairing made then names its port', async () => {
    const { home, server } = await setUp();
    const port = await freePort();
    const stop = new AbortController();
    const io = capture(home);
    let listening: (port: number) => void = () => undefined;
    const started = new Promise<number>((resolve) => (listening = resolve));
    const running = agentCommand({ command: 'agent-run' }, io.io, {
      stop: stop.signal,
      ports: [port],
      onListening: (at) => listening(at),
    });
    expect(await started).toBe(port);
    expect(io.out()).toContain(`listening on 127.0.0.1:${String(port)}`);
    expect(JSON.parse(await readFile(join(home, AGENT_STATUS_FILE), 'utf8'))).toEqual({ pid: process.pid, port });

    await run(home, ['pair', server.code, '--server', server.url]);
    expect([...server.pairings.values()][0]?.port).toBe(port);
    expect((await run(home, ['status'])).out).toContain(`Agent: running on 127.0.0.1:${String(port)}`);

    stop.abort();
    expect(await running).toBe(0);
    expect(io.out()).toContain('Wirebench agent stopped.');
    expect(existsSync(join(home, AGENT_STATUS_FILE))).toBe(false);
  });

  it('unpairs every server it can: a refusal is kept and exits 3, a server gone is dropped with a warning', async () => {
    const { home, server: reachable } = await setUp();
    const refusing = await startFakePairingServer();
    const gone = await startFakePairingServer();
    cleanups.push(
      () => refusing.close(),
      () => gone.close(),
    );
    for (const one of [refusing, gone, reachable]) {
      expect((await run(home, ['pair', one.code, '--server', one.url])).code).toBe(0);
    }
    refusing.refuseUnpair = true;
    await gone.close();

    const result = await run(home, ['unpair']);
    expect(result.code).toBe(3);
    expect(result.out).toContain(`Unpaired from ${reachable.url}`);
    expect(result.out).toContain(`Removed ${gone.url} here`);
    expect(result.err).toContain(`${gone.url} could not be reached: it still lists this machine`);
    expect(result.err).toContain(`${refusing.url}: The server refused the unpairing (HTTP 403)`);
    expect(reachable.pairings.size).toBe(0);
    expect(refusing.pairings.size).toBe(1);
    const status = (await run(home, ['status'])).out;
    expect(status).toContain(refusing.url);
    expect(status).not.toContain(gone.url);
    expect(status).not.toContain(reachable.url);

    // --local forgets it here without asking the server.
    const local = await run(home, ['unpair', '--local', '--server', refusing.url]);
    expect(local).toMatchObject({ code: 0 });
    expect(local.out).toContain(`Removed ${refusing.url} here`);
    expect(local.err).toContain('it still lists this machine');
    expect(refusing.signed.filter((one) => one.method === 'DELETE')).toHaveLength(1);
    expect((await run(home, ['status'])).out).toContain('Pairings: none');
  });

  it('reaches a pairing server through HTTPS_PROXY', async () => {
    const { home } = await setUp();
    const seen: string[] = [];
    const proxy = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        seen.push(chunk.toString('latin1').split('\r\n')[0] ?? '');
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const { port } = proxy.address() as { port: number };
    const result = await run(home, ['pair', 'ABC234', '--server', 'https://wirebench.example.test'], {
      HTTPS_PROXY: `http://127.0.0.1:${String(port)}`,
    });
    expect(result.code).toBe(3);
    expect(seen).toEqual(['CONNECT wirebench.example.test:443 HTTP/1.1']);
  });

  it('refuses to start when the key can be read by others', async () => {
    if (process.platform === 'win32') return;
    const { home, server } = await setUp();
    await run(home, ['pair', server.code, '--server', server.url]);
    const { chmod } = await import('node:fs/promises');
    await chmod(join(home, 'agent.key'), 0o640);
    const refused = await run(home, ['status']);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain(`chmod 600 ${join(home, 'agent.key')}`);
  });
});
