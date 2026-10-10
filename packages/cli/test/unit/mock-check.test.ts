/**
 * `wirebench mock check` (#325) in process: argument parsing, the text and JSON reports, and the exit
 * codes. The fixture holds two generated REST mocks whose stubs conform; a copy breaks one.
 */
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { UsageError, parseCliArgs } from '../../src/args.js';
import type { MockCheckArgs } from '../../src/args.js';
import { mockCheckCommand } from '../../src/commands/mock-check.js';
import { ExitCode } from '../../src/exit-codes.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mock-project');

function checkArgs(argv: readonly string[]): MockCheckArgs {
  const args = parseCliArgs(['mock', 'check', ...argv]);
  if (args.command !== 'mock-check') throw new Error(`parsed as ${args.command}`);
  return args;
}

async function run(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = new PassThrough();
  const err = new PassThrough();
  let stdout = '';
  let stderr = '';
  out.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  err.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await mockCheckCommand(checkArgs(argv), { stdout: out, stderr: err, env: {} });
  return { code, stdout, stderr };
}

/** A copy of the fixture whose `Orders` createOrder stub answers 500, a status the contract does not document. */
async function brokenCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-mock-check-'));
  await cp(FIXTURE, dir, { recursive: true });
  const file = join(dir, 'mocks', 'orders', 'operations', 'createOrder', 'Default.response.yaml');
  await writeFile(file, (await readFile(file, 'utf8')).replace('status: 201', 'status: 500'));
  return dir;
}

describe('wirebench mock check', () => {
  it('parses the path, the selectors and --json, and refuses serving flags', () => {
    expect(checkArgs(['./p', 'Orders', '--json'])).toEqual({
      command: 'mock-check',
      path: './p',
      mocks: ['Orders'],
      json: true,
    });
    expect(() => checkArgs([])).toThrow(UsageError);
    expect(() => checkArgs(['./p', '--port', '0'])).toThrow('--port does not apply to wirebench mock check');
  });

  it('exits 0 when every stub conforms', async () => {
    const { code, stdout } = await run([FIXTURE]);
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toContain('Orders: 2 stubs conform to the contract\n');
    expect(stdout).toContain('Orders backup: 2 stubs conform to the contract\n');
  });

  it('lists a stub that does not conform and exits 1', async () => {
    const dir = await brokenCopy();
    const { code, stdout } = await run([dir, 'Orders']);
    expect(code).toBe(ExitCode.AssertionFailed);
    expect(stdout).toBe(
      'Orders: 1 of 2 stubs do not conform to the contract\n' +
        '  createOrder › Default (500)\n' +
        '    status: The contract declares no 500 response\n',
    );
    const json = await run([dir, 'Orders', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({
      mock: 'Orders',
      checked: 2,
      findings: [{ operation: 'post /orders', responseName: 'Default', status: 500 }],
    });
  });
});
