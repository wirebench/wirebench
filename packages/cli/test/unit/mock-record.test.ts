/**
 * `wirebench mock record` (#60, spec §CLI): its arguments, a recording into a mock it creates with
 * `--from`, stopped by the test's own signal, and the refusals.
 */
import { PassThrough } from 'node:stream';
import { loadProject } from '@wirebench/engine';
import type { RunningRecorder } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../../src/args.js';
import { mockRecordCommand } from '../../src/commands/mock-record.js';
import { ExitCode } from '../../src/exit-codes.js';
import { main } from '../../src/main.js';
import { removeTempDirs, restProject, startServer } from './ops/helpers.js';
import type { TestServer } from './ops/helpers.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeTempDirs();
});

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { stream, text: () => text };
}

const RECORD = {
  command: 'mock-record',
  mock: 'Pets mock',
  replace: false,
  dedupe: true,
  insecure: false,
} as const;

describe('wirebench mock record arguments', () => {
  it('parses the subcommand and its flags', () => {
    expect(
      parseCliArgs([
        'mock',
        'record',
        'proj',
        'Orders',
        '--target',
        'https://real.example/api',
        '--from',
        'Orders API',
        '--port',
        '8089',
        '--host',
        '0.0.0.0',
        '--replace',
        '--no-dedupe',
        '--insecure',
      ]),
    ).toEqual({
      command: 'mock-record',
      path: 'proj',
      mock: 'Orders',
      target: 'https://real.example/api',
      from: 'Orders API',
      port: 8089,
      host: '0.0.0.0',
      replace: true,
      dedupe: false,
      insecure: true,
    });
  });

  it.each([
    // Anything but `record` after `mock` is a project path to serve (#61), which takes no --target.
    [['mock', 'serve', 'p', 'm', '--target', 'http://x'], '--target does not apply to wirebench mock'],
    [['mock', 'record', 'p', '--target', 'http://x'], '<path> and <mock> are required'],
    [['mock', 'record', 'p', 'm'], '--target is required'],
    [['mock', 'record', 'p', 'm', '--target', 'http://x', '--port', '70000'], '--port must be'],
    [['mock', 'record', 'p', 'm', '--target', 'http://x', '--json'], '--json does not apply'],
    [['run', 'p', '--target', 'http://x'], '--target does not apply to wirebench run'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

describe('wirebench mock record', () => {
  it('creates the mock with --from, records through to the target, and saves the stubs on stop', async () => {
    const fixture = await restProject();
    const upstream = await startServer(() => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '[{"id":1,"name":"Rex"}]',
    }));
    servers.push(upstream);
    const stderr = capture();
    const controller = new AbortController();
    let listening: (recorder: RunningRecorder) => void = () => undefined;
    const ready = new Promise<RunningRecorder>((resolve) => {
      listening = resolve;
    });
    const done = mockRecordCommand(
      { ...RECORD, path: fixture.dir, target: upstream.url, from: 'Pets', port: 0 },
      { stdout: capture().stream, stderr: stderr.stream, env: {} },
      { stop: controller.signal, onListening: (recorder) => listening(recorder) },
    );
    const recorder = await ready;
    const reply = await fetch(`${recorder.url}pets`);
    expect(await reply.text()).toBe('[{"id":1,"name":"Rex"}]');
    controller.abort();
    expect(await done).toBe(ExitCode.Ok);

    expect(upstream.received[0]?.url).toBe('/pets');
    expect(stderr.text()).toMatch(/^recording http:\/\/127\.0\.0\.1:\d+\/ -> http/m);
    expect(stderr.text()).toContain('GET /pets 200 get /pets recorded');
    expect(stderr.text()).toContain('saved 1 stubs to mocks/Pets mock/ (0 skipped)');
    const mock = (await loadProject(fixture.dir)).project.mocks[0];
    expect(mock?.name).toBe('Pets mock');
    expect(mock?.operations.map((operation) => operation.operation)).toEqual(['get /pets']);
    expect(mock?.operations[0]?.responses[0]?.bodyText).toBe('[{"id":1,"name":"Rex"}]');
  });

  it('leaves the project alone when nothing was recorded', async () => {
    const fixture = await restProject();
    const stderr = capture();
    const controller = new AbortController();
    controller.abort();
    const code = await mockRecordCommand(
      { ...RECORD, path: fixture.dir, target: 'http://127.0.0.1:1', from: 'Pets', port: 0 },
      { stdout: capture().stream, stderr: stderr.stream, env: {} },
      { stop: controller.signal },
    );
    expect(code).toBe(ExitCode.Ok);
    expect(stderr.text()).toContain('nothing recorded');
    expect((await loadProject(fixture.dir)).project.mocks).toEqual([]);
  });

  it('exits 2 for an unknown mock, an unknown --from and a bad target', async () => {
    const fixture = await restProject();
    const run = async (argv: readonly string[]): Promise<{ code: number; err: string }> => {
      const stderr = capture();
      const code = await main(argv, { stdout: capture().stream, stderr: stderr.stream, env: {} });
      return { code, err: stderr.text() };
    };
    const base = ['mock', 'record', fixture.dir, 'Nope'];
    expect(await run([...base, '--target', 'http://x'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('--from') as unknown,
    });
    expect(await run([...base, '--target', 'http://x', '--from', 'Missing'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('no interface or API called "Missing"') as unknown,
    });
    expect(await run([...base, '--target', 'ftp://x', '--from', 'Pets', '--port', '0'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('mock-record-target-invalid') as unknown,
    });
  });
});

describe('wirebench mock --help', () => {
  it('prints the record help', async () => {
    const stdout = capture();
    expect(await main(['mock', 'record', '--help'], { stdout: stdout.stream, stderr: capture().stream, env: {} })).toBe(
      ExitCode.Ok,
    );
    expect(stdout.text()).toContain('wirebench mock record <path> <mock> --target <url>');
  });
});
