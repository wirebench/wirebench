import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeDb, testDatabase } from '../helpers/database.js';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));

async function exec(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, ...env } });
    return { code: 0, ...result };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe('wirebench-server bin', () => {
  it('--version and --help exit 0', async () => {
    expect((await exec(['--version'], {})).code).toBe(0);
    expect((await exec(['--help'], {})).stdout).toContain('config check');
  });
  it('config check exits 2 with the missing variables and no values', async () => {
    const result = await exec(['config', 'check'], { WIREBENCH_SERVER_DATABASE_URL: 'postgres://s3cret@h/d' });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('WIREBENCH_SERVER_PUBLIC_URL');
    expect(`${result.stdout}${result.stderr}`).not.toContain('s3cret');
  });
});

describeDb('migrate --check against PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(() => db.close());

  it('reports pending, applies, then reports up to date', async () => {
    const env = { WIREBENCH_SERVER_DATABASE_URL: db.url, WIREBENCH_SERVER_PUBLIC_URL: 'https://x.test' };
    expect((await exec(['migrate', '--check'], env)).code).toBe(1);
    expect((await exec(['migrate'], env)).code).toBe(0);
    expect((await exec(['migrate', '--check'], env)).code).toBe(0);
    expect((await exec(['migrate'], env)).code).toBe(0);
  });
});
