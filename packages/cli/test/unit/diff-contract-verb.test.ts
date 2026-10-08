import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/main.js';
import type { CliIo } from '../../src/main.js';
import { runOp } from '../../src/ops/context.js';
import { importOp } from '../../src/ops/import.js';
import { emptyProject, removeTempDirs, tempDir } from './ops/helpers.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures');
const WSDL_V1 = join(ROOT, 'wsdl', 'crafted', 'contract-diff', 'v1.wsdl');
const WSDL_V2 = join(ROOT, 'wsdl', 'crafted', 'contract-diff', 'v2.wsdl');
const OPENAPI_V1 = join(ROOT, 'openapi', 'crafted', 'contract-diff', 'v1.yaml');
const OPENAPI_V2 = join(ROOT, 'openapi', 'crafted', 'contract-diff', 'v2.yaml');

afterEach(async () => {
  await removeTempDirs();
});

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) } as unknown as CliIo['stdout'],
    stderr: { write: (chunk: string) => ((stderr += chunk), true) } as unknown as CliIo['stderr'],
    env: {},
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

describe('wirebench diff-contract', () => {
  it('prints each change and fails on a breaking one', async () => {
    const { code, stdout, stderr } = await run(['diff-contract', WSDL_V1, WSDL_V2]);
    expect(stderr).toBe('');
    expect(code).toBe(1);
    expect(stdout).toContain('BREAKING    OrderBinding#PlaceOrder request.note  note is now required\n');
    expect(stdout).toContain('compatible  OrderBinding#TrackOrder  operation added\n');
    expect(stdout.endsWith('7 breaking, 2 compatible changes in 2 operations compared\n')).toBe(true);
  });

  it('passes for the same contract, and --fail-on decides what fails', async () => {
    expect((await run(['diff-contract', OPENAPI_V1, OPENAPI_V1])).code).toBe(0);
    expect((await run(['diff-contract', OPENAPI_V1, OPENAPI_V2, '--fail-on', 'none'])).code).toBe(0);
    expect((await run(['diff-contract', OPENAPI_V1, OPENAPI_V2, '--fail-on', 'any'])).code).toBe(1);
    expect((await run(['diff-contract', OPENAPI_V1, OPENAPI_V1, '--fail-on', 'any'])).code).toBe(0);
  });

  it('prints the counts only with -q', async () => {
    const { stdout } = await run(['diff-contract', OPENAPI_V1, OPENAPI_V2, '-q']);
    expect(stdout).toBe('8 breaking, 3 compatible changes in 2 operations compared\n');
  });

  it('writes Markdown, HTML and JSON reports', async () => {
    const dir = await tempDir();
    const files = { markdown: join(dir, 'diff.md'), html: join(dir, 'out', 'diff.html'), json: join(dir, 'diff.json') };
    const { code } = await run([
      'diff-contract',
      OPENAPI_V1,
      OPENAPI_V2,
      '--reporter',
      `markdown=${files.markdown}`,
      '--reporter',
      `html=${files.html}`,
      '--reporter',
      `json=${files.json}`,
    ]);
    expect(code).toBe(1);
    expect(await readFile(files.markdown, 'utf8')).toContain('## Breaking changes');
    expect(await readFile(files.html, 'utf8')).toContain('<h2 class="danger">Breaking changes (8)</h2>');
    const json = JSON.parse(await readFile(files.json, 'utf8')) as { summary: unknown; format: string };
    expect(json.format).toBe('openapi');
    expect(json.summary).toEqual({ breaking: 8, compatible: 3 });
  });

  it("reads project:<name> from the project's definition cache", async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: WSDL_V1 }, fixture.base());
    await runOp(importOp, { source: OPENAPI_V1 }, fixture.base());
    const soap = await run(['diff-contract', 'project:OrderService', WSDL_V2, '--project', fixture.dir, '-q']);
    expect(soap.stderr).toBe('');
    expect(soap.stdout).toBe('7 breaking, 2 compatible changes in 2 operations compared\n');
    const rest = await run(['diff-contract', 'project:Orders', OPENAPI_V2, '--project', fixture.dir, '-q']);
    expect(rest.stdout).toBe('8 breaking, 3 compatible changes in 2 operations compared\n');
    const missing = await run(['diff-contract', 'project:Nope', OPENAPI_V2, '--project', fixture.dir]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('container-not-found');
  });

  it('refuses two different formats, an unreadable file and bad flags with exit 2', async () => {
    const mixed = await run(['diff-contract', WSDL_V1, OPENAPI_V1]);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain('contract-formats-differ');
    const missing = await run(['diff-contract', join(ROOT, 'no-such.wsdl'), WSDL_V1]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('file-not-found');
    expect((await run(['diff-contract', WSDL_V1, WSDL_V2, '--fail-on', 'sometimes'])).code).toBe(2);
    expect((await run(['diff-contract', WSDL_V1, WSDL_V2, '--reporter', 'junit=x.xml'])).code).toBe(2);
    expect((await run(['diff-contract', WSDL_V1, WSDL_V2, '--bail'])).code).toBe(2);
    expect((await run(['diff-contract', WSDL_V1])).code).toBe(2);
  });

  it('has its own help, and --fail-on belongs to it alone', async () => {
    const help = await run(['diff-contract', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--fail-on <when>');
    expect((await run(['--help'])).stdout).toContain('wirebench diff-contract <old> <new>');
    const refused = await run(['run', '.', '--fail-on', 'any']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--fail-on does not apply to wirebench run');
  });
});
