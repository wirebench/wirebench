import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/args.js';
import { ExitCode } from '../../src/exit-codes.js';
import { main } from '../../src/main.js';
import { emptyProject, removeTempDirs, restProject, soapProject, tempDir } from './ops/helpers.js';

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function cli(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout: stdout.stream, stderr: stderr.stream, env: {} });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

afterEach(removeTempDirs);

describe('wirebench export', () => {
  it('writes a Postman collection and reports what did not fit', async () => {
    const fixture = await soapProject();
    const out = join(await tempDir(), 'nested');
    const result = await cli(['export', 'postman', '--project', fixture.dir, '--out', out]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(await readdir(out)).toEqual(['mcp-fixture.postman_collection.json']);
    expect(result.stdout).toContain(`Wrote ${join(out, 'mcp-fixture.postman_collection.json')}`);
    const collection = JSON.parse(await readFile(join(out, 'mcp-fixture.postman_collection.json'), 'utf8')) as {
      item: { name: string }[];
    };
    expect(collection.item.map((i) => i.name)).toEqual(['CalculatorService']);
  });

  it('writes one API as OpenCollection, with --json', async () => {
    const fixture = await restProject();
    const out = await tempDir();
    const result = await cli([
      'export',
      'opencollection',
      '--project',
      fixture.dir,
      '--out',
      out,
      '--json',
      '--api',
      'pets',
    ]);
    expect(result.code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(result.stdout) as { files: string[]; counts: { requests: number }; report: object };
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatch(/\.opencollection\.yml$/);
    expect(parsed.counts.requests).toBeGreaterThan(0);
    expect(await readFile(parsed.files[0]!, 'utf8')).toMatch(/^opencollection: 1\.0\.0/);
  });

  it('exits 3 for an --api the project does not have, and when there is nothing to export', async () => {
    const fixture = await soapProject();
    const missing = await cli([
      'export',
      'postman',
      '--project',
      fixture.dir,
      '--out',
      await tempDir(),
      '--api',
      'Nope',
    ]);
    expect(missing.code).toBe(ExitCode.RunError);
    expect(missing.stderr).toContain('no API or interface "Nope" in the project (it has: CalculatorService)');

    const empty = await emptyProject();
    const nothing = await cli(['export', 'postman', '--project', empty.dir, '--out', await tempDir()]);
    expect(nothing.code).toBe(ExitCode.RunError);
    expect(nothing.stderr).toContain('export-nothing');
  });

  it('refuses a missing format and a foreign flag', () => {
    expect(() => parseCliArgs(['export'])).toThrow(/usage: wirebench export/);
    expect(() => parseCliArgs(['export', 'har'])).toThrow(/usage: wirebench export/);
    expect(() => parseCliArgs(['export', 'postman', '--name', 'x'])).toThrow(
      '--name does not apply to wirebench export',
    );
    expect(() => parseCliArgs(['run', '.', '--out', 'x'])).toThrow('--out does not apply to wirebench run');
    expect(parseCliArgs(['export', 'opencollection'])).toEqual({
      command: 'export',
      format: 'opencollection',
      project: '.',
      out: '.',
      json: false,
    });
  });
});
