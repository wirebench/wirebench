/**
 * `wirebench run --data / --iterations / --delay / --data-overrun` (#336): one iteration per row, the row read
 * as `${#Data#…}` by requests and sequence steps, `--bail` stopping the later iterations, and a bad data file
 * refused before anything is sent.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE, runCli, startDemoServer } from './helpers.js';
import type { DemoServer } from './helpers.js';

let demo: DemoServer;
const temps: string[] = [];

beforeAll(async () => {
  demo = await startDemoServer();
});

afterAll(async () => {
  await demo.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  demo.requests.length = 0;
});

const ROWS_API = 'baseUrl: ${baseUrl}\nid: ROWS0001\nkind: rest\nname: rows\norder: 9\n';

function request(id: string, name: string, url: string): string {
  return [
    'auth:',
    '  type: inherit',
    'body:',
    '  kind: none',
    `id: ${id}`,
    'kind: rest',
    'method: GET',
    `name: ${name}`,
    'order: 0',
    `url: ${url}`,
    'assertions:',
    '  - type: status',
    '    equals: 200',
    '',
  ].join('\n');
}

/** The runner fixture plus a `rows` API whose one request reads the row, and a data file beside it. */
async function dataProject(files: Record<string, string>, url = '/ok?user=${#Data#user}'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wirebench-cli-data-'));
  temps.push(root);
  const dir = join(root, 'project');
  await cp(FIXTURE, dir, { recursive: true });
  await mkdir(join(dir, 'apis/rows/requests'), { recursive: true });
  await writeFile(join(dir, 'apis/rows/api.yaml'), ROWS_API);
  await writeFile(join(dir, 'apis/rows/requests/lookup.request.yaml'), request('ROWS0002', 'lookup', url));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(root, name), text);
  }
  return dir;
}

const run = (dir: string, ...rest: string[]): ReturnType<typeof runCli> =>
  runCli(['run', dir, 'apis/rows', '-e', 'local', '--var', `baseUrl=${demo.url}`, ...rest]);

describe('wirebench run --data', () => {
  it('runs once per CSV row, reading each row through ${#Data#…}', async () => {
    const dir = await dataProject({ 'rows.csv': 'user\nann\nbob\n' });
    const { code, stdout, stderr } = await run(dir, '--data', join(dir, '..', 'rows.csv'));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(demo.requests).toEqual(['/ok?user=ann', '/ok?user=bob']);
    expect(stdout).toContain('Iteration 1/2 (row 1)');
    expect(stdout).toContain('Iteration 2/2 (row 2)');
    expect(stdout).toContain('2 passed');
    expect(stdout).toContain('2 iterations');
  });

  it('reads a JSON data file, and wraps round when asked for more iterations than rows', async () => {
    const dir = await dataProject({ 'rows.json': '[{"user":"ann"},{"user":"bob"}]' });
    const { code } = await run(
      dir,
      '--data',
      join(dir, '..', 'rows.json'),
      '--iterations',
      '3',
      '--data-overrun',
      'wrap',
    );
    expect(code).toBe(0);
    expect(demo.requests).toEqual(['/ok?user=ann', '/ok?user=bob', '/ok?user=ann']);
  });

  it('stops after the last row by default', async () => {
    const dir = await dataProject({ 'rows.csv': 'user\nann\n' });
    const { code } = await run(dir, '--data', join(dir, '..', 'rows.csv'), '--iterations', '4');
    expect(code).toBe(0);
    expect(demo.requests).toEqual(['/ok?user=ann']);
  });

  it('repeats the requests without data for --iterations alone', async () => {
    const dir = await dataProject({}, '/ok');
    const { code, stdout } = await run(dir, '--iterations', '3', '--delay', '5');
    expect(code).toBe(0);
    expect(demo.requests).toEqual(['/ok', '/ok', '/ok']);
    expect(stdout).toContain('Iteration 3/3');
  });

  it('under --bail, runs no iteration after the one that failed', async () => {
    const dir = await dataProject({ 'rows.csv': 'path\n/ok\n/broken\n/ok\n' }, '${#Data#path}');
    const { code } = await run(dir, '--data', join(dir, '..', 'rows.csv'), '--bail');
    expect(code).toBe(1);
    expect(demo.requests).toEqual(['/ok', '/broken']);
  });

  it('refuses a bad data file before anything is sent', async () => {
    const dir = await dataProject({ 'rows.csv': 'user\nann,extra\n', 'rows.txt': 'user\nann\n' });
    for (const [file, code] of [
      ['rows.csv', 'data-file-invalid'],
      ['rows.txt', 'data-file-format'],
      ['missing.csv', 'data-file-unreadable'],
    ] as const) {
      const result = await run(dir, '--data', join(dir, '..', file));
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(code);
    }
    expect(demo.requests).toEqual([]);
  });

  it('writes each request’s iteration into the json report', async () => {
    const dir = await dataProject({ 'rows.csv': 'user\nann\nbob\n' });
    const report = join(dir, '..', 'report.json');
    const { code } = await run(dir, '--data', join(dir, '..', 'rows.csv'), '--reporter', `json=${report}`);
    expect(code).toBe(0);
    const json = JSON.parse(await readFile(report, 'utf8')) as {
      summary: { iterations?: unknown };
      requests: { iteration?: unknown }[];
    };
    expect(json.summary.iterations).toEqual({ planned: 2, run: 2 });
    expect(json.requests.map((r) => r.iteration)).toEqual([
      { index: 0, count: 2, row: 0 },
      { index: 1, count: 2, row: 1 },
    ]);
  });

  it('lays the row over every step of a sequence', async () => {
    const dir = await dataProject({ 'rows.csv': 'user\nann\nbob\n' });
    await mkdir(join(dir, 'sequences'), { recursive: true });
    await writeFile(
      join(dir, 'sequences/look.sequence.yaml'),
      'kind: sequence\nversion: 1\nid: SEQ0001\nname: look\norder: 0\nsteps:\n  - id: STEP0001\n    request: ROWS0002\n',
    );
    const { code, stdout } = await runCli([
      'run',
      dir,
      '-e',
      'local',
      '--var',
      `baseUrl=${demo.url}`,
      '--sequence',
      'look',
      '--data',
      join(dir, '..', 'rows.csv'),
    ]);
    expect(code).toBe(0);
    expect(demo.requests).toEqual(['/ok?user=ann', '/ok?user=bob']);
    expect(stdout).toContain('Iteration 2/2 (row 2)');
  });
});
