import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestSoapServer } from '@wirebench/engine/test-helpers';
import type { TestSoapServer } from '@wirebench/engine/test-helpers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE, hashTree, runCli, spawnCli, startDemoServer } from './helpers.js';
import type { DemoServer } from './helpers.js';

let demo: DemoServer;
let soap: TestSoapServer;
let before: Record<string, string>;
const temps: string[] = [];

beforeAll(async () => {
  before = await hashTree(FIXTURE);
  demo = await startDemoServer();
  soap = await startTestSoapServer();
});

afterAll(async () => {
  await demo.close();
  await soap.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  demo.requests.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-cli-'));
  temps.push(dir);
  return dir;
}

const vars = (): string[] => ['--var', `baseUrl=${demo.url}`, '--var', `soapUrl=${soap.url}/soap`];
const run = (...rest: string[]): ReturnType<typeof runCli> =>
  runCli(['run', FIXTURE, '-e', 'local', ...vars(), ...rest]);

describe('wirebench run', () => {
  it('passes a passing request', async () => {
    const { code, stdout } = await run('demo/ok');
    expect(code).toBe(0);
    expect(stdout).toContain('✓ demo/ok');
    expect(stdout).toContain('1 passed');
  });

  it('runs the SOAP request against its environment endpoint', async () => {
    const { code, stdout } = await run('Echo');
    expect(stdout).toContain('Echo/Echo/Say hello');
    expect(code).toBe(0);
  });

  it('exits 1 on a failed status assertion, with expected and actual', async () => {
    const { code, stdout } = await run('demo/broken');
    expect(code).toBe(1);
    expect(stdout).toContain('status is 200');
    expect(stdout).toContain('expected 200');
    expect(stdout).toContain('actual 500');
  });

  it('exits 1 on a missed SLA', async () => {
    const { code, stdout } = await run('demo/slow');
    expect(code).toBe(1);
    expect(stdout).toContain('responds within 50 ms');
  });

  it('exits 3 when the service cannot be reached, printing the transport code', async () => {
    const { code, stdout } = await runCli([
      'run',
      FIXTURE,
      '-e',
      'local',
      '--var',
      'baseUrl=http://127.0.0.1:1',
      'demo/ok',
    ]);
    expect(code).toBe(3);
    expect(stdout).toContain('connection-refused');
  });

  it('exits 2 on an unknown environment, listing the names, before any send', async () => {
    const { code, stderr } = await runCli(['run', FIXTURE, '-e', 'nope', ...vars()]);
    expect(code).toBe(2);
    expect(stderr).toContain('local');
    expect(demo.requests).toHaveLength(0);
  });

  it('exits 2 when no environment is given', async () => {
    const { code, stderr } = await runCli(['run', FIXTURE, ...vars()]);
    expect(code).toBe(2);
    expect(stderr).toContain('an environment is required');
    expect(stderr).toContain('local');
    expect(demo.requests).toHaveLength(0);
  });

  it('exits 2 when a selector matches nothing', async () => {
    const { code, stderr } = await run('Nope');
    expect(code).toBe(2);
    expect(stderr).toContain('matched nothing');
    expect(demo.requests).toHaveLength(0);
  });

  it('exits 2 on a workspace, listing its projects', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'workspace.yaml'),
      [
        'formatVersion: 3',
        'id: WS1',
        'name: Team',
        'createdAt: 2026-09-18T00:00:00.000Z',
        'properties: {}',
        'projects:',
        '  - id: P1',
        '    slug: billing',
        '    source: internal',
        '',
      ].join('\n'),
    );
    const { code, stderr } = await runCli(['run', dir, '-e', 'local']);
    expect(code).toBe(2);
    expect(stderr).toContain('This is a workspace; run one of its projects:');
    expect(stderr).toContain(join(dir, 'projects', 'billing'));
  });

  it('exits 2 when the path does not exist', async () => {
    const { code, stderr } = await runCli(['run', join(tmpdir(), 'wirebench-no-such-project'), '-e', 'local']);
    expect(code).toBe(2);
    expect(stderr).toContain('project-not-found');
  });

  it('exits 2 on an invalid assertion, sending nothing', async () => {
    const dir = await tempDir();
    await cp(FIXTURE, dir, { recursive: true });
    const file = join(dir, 'apis', 'demo', 'requests', 'ok.request.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('type: status', 'type: script'));
    const { code, stderr } = await runCli(['run', dir, '-e', 'local', ...vars()]);
    expect(code).toBe(2);
    expect(stderr).toContain('project-file-invalid');
    expect(demo.requests).toHaveLength(0);
  });

  it('--bail stops after the first failure and skips the rest', async () => {
    // Selection runs in project order (ok, slow, broken): slow fails first, broken is skipped.
    const { code, stdout } = await run('--bail', 'demo/slow', 'demo/broken');
    expect(code).toBe(1);
    expect(stdout).toContain('- demo/broken');
    expect(stdout).toContain('1 skipped');
    expect(demo.requests).toEqual(['/slow']);
  });

  // On Windows `child.kill('SIGINT')` terminates the process outright (no handler runs, no exit
  // code), so there is nothing there for this test to observe.
  it.skipIf(process.platform === 'win32')('exits 130 on SIGINT and still prints the summary', async () => {
    const child = spawnCli(['run', FIXTURE, '-e', 'local', ...vars(), 'demo/slow', 'demo/broken']);
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    let poll: NodeJS.Timeout | undefined;
    try {
      // `/slow` answers 200 ms late, so the interrupt lands while it is in flight.
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        poll = setInterval(() => {
          if (demo.requests.length > 0) {
            resolve();
          } else if (Date.now() > deadline || child.exitCode !== null) {
            reject(new Error(`the run never reached /slow; stdout so far:\n${stdout}`));
          }
        }, 5);
      });
      child.kill('SIGINT');
      const code = await closed;
      expect(code).toBe(130);
      expect(stdout).toContain('skipped');
      expect(demo.requests).toEqual(['/slow']);
    } finally {
      clearInterval(poll);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await closed;
      }
    }
  });

  it('leaves the fixture byte-identical', async () => {
    await run();
    expect(await hashTree(FIXTURE)).toEqual(before);
  });
});
