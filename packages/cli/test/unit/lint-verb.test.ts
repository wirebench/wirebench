import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/main.js';
import type { CliIo } from '../../src/main.js';
import { runOp } from '../../src/ops/context.js';
import { importOp } from '../../src/ops/import.js';
import { emptyProject, removeTempDirs, tempDir } from './ops/helpers.js';

const LINT = join(import.meta.dirname, '..', '..', '..', 'engine', 'test', 'fixtures', 'lint');
const CLEAN = join(LINT, 'clean-3.1.yaml');
const NOISY = join(LINT, 'noisy-3.1.yaml');

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

describe('wirebench lint', () => {
  it('passes a clean document', async () => {
    const { code, stdout, stderr } = await run(['lint', CLEAN]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toMatch(/^0 errors, 0 warnings, 0 infos, 0 hints in .*clean-3\.1\.yaml\n$/);
  });

  it('prints each finding as file:line:col and fails on an error', async () => {
    const { code, stdout } = await run(['lint', NOISY]);
    expect(code).toBe(1);
    expect(stdout).toMatch(
      /noisy-3\.1\.yaml:6:\d+ {2}error {4}owasp-plain-http {2}http:\/\/api\.noisy\.test is plain HTTP.* \(\/servers\/0\/url\)\n/,
    );
    expect(stdout).toMatch(/\n\d+ errors, \d+ warnings, 0 infos, 0 hints in .*noisy-3\.1\.yaml\n$/);
  });

  it('lets --fail-severity decide the gate', async () => {
    expect((await run(['lint', NOISY, '--fail-severity', 'none'])).code).toBe(0);
    const warningsOnly = await tempDir();
    const ruleset = join(warningsOnly, 'quiet.yaml');
    await writeFile(ruleset, 'builtin: [hygiene]\nrules: { operation-operationId-unique: warning }\n');
    expect((await run(['lint', NOISY, '--ruleset', ruleset])).code).toBe(0);
    expect((await run(['lint', NOISY, '--ruleset', ruleset, '--fail-severity', 'warning'])).code).toBe(1);
  });

  it('prints the counts only with -q', async () => {
    const { stdout } = await run(['lint', NOISY, '-q']);
    expect(stdout.split('\n')).toHaveLength(2);
  });

  it('writes JSON and SARIF reports', async () => {
    const dir = await tempDir();
    const files = { json: join(dir, 'lint.json'), sarif: join(dir, 'out', 'lint.sarif') };
    const { code } = await run([
      'lint',
      NOISY,
      '--reporter',
      `json=${files.json}`,
      '--reporter',
      `sarif=${files.sarif}`,
    ]);
    expect(code).toBe(1);
    const json = JSON.parse(await readFile(files.json, 'utf8')) as {
      summary: { error: number };
      declaredVersion: string;
    };
    expect(json.declaredVersion).toBe('3.1.0');
    expect(json.summary.error).toBeGreaterThan(0);
    const sarif = JSON.parse(await readFile(files.sarif, 'utf8')) as {
      version: string;
      runs: { tool: { driver: { name: string } }; results: { ruleId: string; locations: unknown[] }[] }[];
    };
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0]?.tool.driver.name).toBe('wirebench');
    expect(sarif.runs[0]?.results.some((result) => result.ruleId === 'owasp-plain-http')).toBe(true);
  });

  it("applies the project's lint/ folder, then --ruleset files", async () => {
    const fixture = await emptyProject();
    await mkdir(join(fixture.dir, 'lint'));
    await writeFile(
      join(fixture.dir, 'lint', 'a.yaml'),
      'builtin: []\nrules:\n  t: { target: info, field: title, check: max-length, value: 3, severity: error }\n',
    );
    expect((await run(['lint', CLEAN, '--project', fixture.dir])).code).toBe(1);
    const off = join(await tempDir(), 'off.yaml');
    await writeFile(off, 'rules: { t: off }\n');
    expect((await run(['lint', CLEAN, '--project', fixture.dir, '--ruleset', off])).code).toBe(0);
  });

  it("lints project:<name> from the project's definition cache", async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: NOISY }, fixture.base());
    const { code, stdout } = await run(['lint', 'project:Noisy', '--project', fixture.dir]);
    expect(code).toBe(1);
    expect(stdout).toContain('owasp-plain-http');
    expect(stdout).toMatch(/in project:Noisy\n$/);
  });

  it('refuses what it cannot lint with exit 2 or 3', async () => {
    const bad = join(await tempDir(), 'bad.yaml');
    await writeFile(bad, 'rules: { nope: off }\n');
    const ruleset = await run(['lint', CLEAN, '--ruleset', bad]);
    expect(ruleset.code).toBe(2);
    expect(ruleset.stderr).toMatch(/^lint-ruleset-invalid: .*bad\.yaml: rules\.nope/);
    expect((await run(['lint', join(LINT, 'swagger-1.2.json')])).code).toBe(2);
    expect((await run(['lint', join(LINT, 'missing.yaml')])).code).toBe(2);
    const garbage = join(await tempDir(), 'x.yaml');
    await writeFile(garbage, '{ nope');
    expect((await run(['lint', garbage])).code).toBe(3);
    expect((await run(['lint', CLEAN, '--fail-severity', 'loud'])).code).toBe(2);
    expect((await run(['lint', CLEAN, '--reporter', 'html=x.html'])).code).toBe(2);
    expect((await run(['lint'])).code).toBe(2);
    expect((await run(['run', '.', '--ruleset', 'x'])).code).toBe(2);
  });

  it('has its own help', async () => {
    const { stdout } = await run(['lint', '--help']);
    expect(stdout).toContain('--fail-severity');
  });
});
