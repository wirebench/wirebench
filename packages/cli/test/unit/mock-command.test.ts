/**
 * `wirebench mock` (#61) in process: argument parsing, mock selection, the text and JSON log, and the
 * start failures. The fixture holds two generated REST mocks of one OpenAPI document.
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { loadProject } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { UsageError, parseCliArgs } from '../../src/args.js';
import type { MockArgs } from '../../src/args.js';
import { mockCommand, selectMocks } from '../../src/commands/mock.js';
import type { CliIo } from '../../src/main.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mock-project');

function mockArgs(argv: readonly string[]): MockArgs {
  const args = parseCliArgs(['mock', ...argv]);
  if (args.command !== 'mock') throw new Error(`parsed as ${args.command}`);
  return args;
}

interface Captured {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves with stdout once it holds `text`. */
  readonly waitFor: (text: string) => Promise<string>;
}

function capture(env: NodeJS.ProcessEnv = {}): Captured {
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = '';
  let stderr = '';
  const waiters: { text: string; resolve: (s: string) => void }[] = [];
  out.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const waiter of waiters.filter((w) => stdout.includes(w.text))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(stdout);
    }
  });
  err.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return {
    io: { stdout: out, stderr: err, env },
    stdout: () => stdout,
    stderr: () => stderr,
    waitFor: (text) =>
      stdout.includes(text) ? Promise.resolve(stdout) : new Promise((resolve) => waiters.push({ text, resolve })),
  };
}

/** Starts the command in process; `stop()` aborts it and resolves with its exit code. */
function serve(argv: readonly string[], env?: NodeJS.ProcessEnv): Captured & { readonly stop: () => Promise<number> } {
  const captured = capture(env);
  const controller = new AbortController();
  const done = mockCommand(mockArgs(argv), captured.io, { stop: controller.signal });
  return {
    ...captured,
    stop: async () => {
      controller.abort();
      return done;
    },
  };
}

describe('wirebench mock arguments', () => {
  it('parses the path, the selectors and the flags', () => {
    expect(mockArgs(['./p', 'Orders', 'M2', '--port', '0', '--host', '0.0.0.0', '--json', '-q'])).toEqual({
      command: 'mock',
      path: './p',
      mocks: ['Orders', 'M2'],
      port: 0,
      host: '0.0.0.0',
      json: true,
      quiet: true,
    });
    expect(mockArgs(['./p'])).toEqual({ command: 'mock', path: './p', mocks: [], json: false, quiet: false });
  });

  it('refuses a missing path, a bad port, an empty host and the flags of other verbs', () => {
    expect(() => parseCliArgs(['mock'])).toThrow(/<path> is required/);
    for (const port of ['-1', '65536', '1.5', 'abc', '']) {
      expect(() => parseCliArgs(['mock', 'p', `--port=${port}`])).toThrow(/--port must be a port from 0 to 65535/);
    }
    expect(() => parseCliArgs(['mock', 'p', '--host', ' '])).toThrow(/--host needs an address/);
    expect(() => parseCliArgs(['mock', 'p', '--allow-send'])).toThrow(/does not apply to wirebench mock/);
    expect(() => parseCliArgs(['mock', 'p', '-e', 'dev'])).toThrow(UsageError);
    expect(() => parseCliArgs(['run', 'p', '--port', '1'])).toThrow(/--port does not apply to wirebench run/);
  });

  it('has its own --help', () => {
    expect(parseCliArgs(['mock', '--help'])).toEqual({ command: 'help', topic: 'mock' });
  });
});

describe('selectMocks', () => {
  it('selects by id, folder slug or name, in the project order; every mock when none is named', async () => {
    const { project, problems } = await loadProject(FIXTURE);
    expect(problems).toEqual([]);
    const ids = (names: readonly string[]): string[] => selectMocks(project, names).map((mock) => mock.id);
    expect(ids([])).toEqual(['M1', 'M2']);
    expect(ids(['orders-backup', 'Orders'])).toEqual(['M1', 'M2']);
    expect(ids(['M2', 'Orders backup'])).toEqual(['M2']);
    expect(() => ids(['nope'])).toThrow(/No mock is named "nope"; the project's mocks:\n {2}Orders \(orders, M1\)/);
    expect(() => selectMocks({ ...project, mocks: [] }, [])).toThrow(/The project has no mocks/);
    const twin = { ...project, mocks: [...project.mocks, { ...project.mocks[0]!, id: 'M3', slug: 'other' }] };
    expect(() => selectMocks(twin, ['Orders'])).toThrow(/More than one mock is named "Orders"/);
  });
});

describe('wirebench mock', () => {
  it('serves one mock on a free port, logs each request as text, and exits 0 when stopped', async () => {
    const run = serve([FIXTURE, 'orders', '--port', '0']);
    const started = await run.waitFor('\n');
    const url = /^listening Orders (http:\/\/127\.0\.0\.1:\d+\/orders-api)$/m.exec(started)?.[1];
    expect(url).toBeDefined();

    const ok = await fetch(`${String(url)}/orders`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([{ id: 1 }]);
    const bad = await fetch(`${String(url)}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"qty":0}',
    });
    expect(bad.status).toBe(400);
    await run.waitFor('mock-request-invalid');

    expect(await run.stop()).toBe(0);
    const lines = run.stdout().trimEnd().split('\n');
    expect(lines[1]).toMatch(/^\S+Z Orders GET \/orders-api\/orders 200 get \/orders → Default \d+ms$/);
    expect(lines[2]).toMatch(/^\S+Z Orders POST \/orders-api\/orders 400 post \/orders \d+ms$/);
    // The refusal's error repeats its problem, so it is said once.
    expect(lines.slice(3)).toEqual(['  mock-request-invalid: below the minimum 1']);
    expect(run.stderr()).toBe('');
  });

  it('writes JSON lines with the mock named on each, the exchange masked as the engine logs it', async () => {
    const run = serve([FIXTURE, 'M2', '--port', '0', '--json']);
    const listening = JSON.parse((await run.waitFor('\n')).trim()) as Record<string, unknown>;
    expect(listening).toMatchObject({ type: 'listening', mockId: 'M2', mock: 'Orders backup', host: '127.0.0.1' });
    await fetch(`${String(listening['url'])}/orders`, { headers: { authorization: 'Bearer abcdefghijklmnop' } });
    await run.waitFor('"exchange"');
    expect(await run.stop()).toBe(0);

    const exchange = JSON.parse(run.stdout().trim().split('\n')[1] ?? '') as {
      type: string;
      mock: string;
      status: number;
      request: { headers: [string, string][] };
    };
    expect(exchange).toMatchObject({ type: 'exchange', mock: 'Orders backup', status: 200 });
    const auth = exchange.request.headers.find(([name]) => name.toLowerCase() === 'authorization');
    expect(auth?.[1]).not.toContain('abcdefghijklmnop');
  });

  it('prints only the listening lines with -q, one per mock', async () => {
    const run = serve([FIXTURE, '-q'], { WIREBENCH_MOCK_HOST: '127.0.0.1' });
    await run.waitFor('Orders backup');
    // Both fixture mocks have port 0, so each gets its own free port.
    const urls = [...run.stdout().matchAll(/^listening (.+) (http:\S+)$/gm)].map((m) => [m[1], m[2]]);
    expect(urls.map(([name]) => name)).toEqual(['Orders', 'Orders backup']);
    await fetch(`${String(urls[0]?.[1])}/orders`);
    expect(await run.stop()).toBe(0);
    expect(run.stdout().trimEnd().split('\n')).toHaveLength(2);
  });

  it('listens on WIREBENCH_MOCK_HOST when --host is absent, and warns off loopback', async () => {
    const run = serve([FIXTURE, 'orders', '--port', '0'], { WIREBENCH_MOCK_HOST: '0.0.0.0' });
    await run.waitFor('\n');
    expect(await run.stop()).toBe(0);
    expect(run.stdout()).toMatch(/^listening Orders http:\/\/0\.0\.0\.0:\d+\/orders-api$/m);
    expect(run.stderr()).toContain('warning: listening on 0.0.0.0: any client that can reach the port');

    const flag = serve([FIXTURE, 'orders', '--port', '0', '--host', 'localhost'], { WIREBENCH_MOCK_HOST: '0.0.0.0' });
    await flag.waitFor('\n');
    expect(await flag.stop()).toBe(0);
    expect(flag.stdout()).toMatch(/^listening Orders http:\/\/localhost:\d+\/orders-api$/m);
    expect(flag.stderr()).toBe('');
  });

  it('exits 3 when a mock cannot listen, and stops the ones already started', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    try {
      const captured = capture();
      const code = await mockCommand(mockArgs([FIXTURE, 'orders', '--port', String(port)]), captured.io);
      expect(code).toBe(3);
      expect(captured.stderr()).toContain('mock-port-in-use');
      expect(captured.stdout()).toBe('');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('refuses --port with several mocks, and a path that is not a project', async () => {
    const captured = capture();
    await expect(mockCommand(mockArgs([FIXTURE, '--port', '0']), captured.io)).rejects.toThrow(
      /--port takes one mock; 2 are selected/,
    );
    expect(await mockCommand(mockArgs([join(FIXTURE, 'nope')]), captured.io)).toBe(2);
  });
});
