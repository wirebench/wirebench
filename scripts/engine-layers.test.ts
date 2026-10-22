/**
 * The engine's dependency rules (package split spec §3.1), checked by the import-graph script: against a
 * fixture tree that breaks each rule once, and against the real tree.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./engine-import-graph.mjs', import.meta.url));

interface ReportedEdge {
  readonly from: string;
  readonly to: string;
  readonly fromGroup: string;
  readonly toGroup: string;
  readonly typeOnly: boolean;
}

interface Report {
  readonly edges: readonly ReportedEdge[];
  readonly violations: readonly ReportedEdge[];
  readonly banned: readonly { readonly from: string; readonly specifier: string }[];
  readonly unresolved: readonly string[];
}

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A source tree with one import of each kind the rules tell apart. */
const FIXTURE: Readonly<Record<string, string>> = {
  'http/entries.ts': 'export const shared = 1;\n',
  'rest/model.ts': 'export interface RestApi {\n  readonly id: string;\n}\nexport const REST = 1;\n',
  // A protocol importing core and itself: no edge.
  'rest/send.ts':
    "import { shared } from '../http/entries.js';\nimport { REST } from './model.js';\nexport const sent = shared + REST;\n",
  // Rule 1, and a type-only import breaks it too.
  'grpc/model.ts':
    "import type { RestApi } from '../rest/model.js';\nexport interface GrpcApi {\n  readonly rest: RestApi;\n}\n",
  // Rule 2.
  'assert/status.ts': "import { REST } from '../rest/model.js';\nexport const status = REST;\n",
  'soap/model.ts': 'export interface Interface {\n  readonly id: string;\n}\n',
  // Rule 2 again: SOAP's type in core, type-only.
  'project/environments.ts':
    "import type { Interface } from '../soap/model.js';\nexport interface Endpoints {\n  readonly of?: Interface;\n}\n",
  // Compose imports a protocol: allowed.
  'import/http-file/map.ts': "import { REST } from '../../rest/model.js';\nexport const mapped = REST;\n",
  'protocols.ts': "import { REST } from './rest/model.js';\nexport const registry = REST;\n",
  // Rule 3: core importing compose.
  'run/select.ts': "import { registry } from '../protocols.js';\nexport const selected = registry;\n",
  // An `import()` type is an import.
  'script/run.ts': "export type Api = import('../rest/model.js').RestApi;\n",
  // A banned package.
  'xml/parse.ts': "import { app } from 'electron';\nexport const parse = app;\n",
};

describe('engine-import-graph.mjs', () => {
  let fixture: string;

  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'wirebench-engine-layers-'));
    for (const [file, text] of Object.entries(FIXTURE)) {
      await mkdir(dirname(join(fixture, file)), { recursive: true });
      await writeFile(join(fixture, file), text);
    }
  });

  afterAll(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it('reports every import that leaves its group, and which of them break a rule', () => {
    const result = run(['--src', fixture, '--json']);
    const report = JSON.parse(result.stdout) as Report;

    expect(report.unresolved).toEqual([]);
    expect(report.edges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual([
      'assert/status.ts -> rest/model.ts',
      'grpc/model.ts -> rest/model.ts',
      'import/http-file/map.ts -> rest/model.ts',
      'project/environments.ts -> soap/model.ts',
      'protocols.ts -> rest/model.ts',
      'run/select.ts -> protocols.ts',
      'script/run.ts -> rest/model.ts',
    ]);
    expect(report.violations.map((edge) => edge.from)).toEqual([
      'assert/status.ts',
      'grpc/model.ts',
      'project/environments.ts',
      'run/select.ts',
      'script/run.ts',
    ]);
    expect(report.banned).toEqual([{ from: 'xml/parse.ts', specifier: 'electron' }]);
  }, 30_000);

  it('exits non-zero under --check and names the rule each import breaks', () => {
    const result = run(['--src', fixture, '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[grpc->rest] grpc/model.ts -> rest/model.ts : RestApi (type-only)');
    expect(result.stderr).toContain('breaks rule 1: no other protocol group');
    expect(result.stderr).toContain('[core->rest] assert/status.ts -> rest/model.ts : REST');
    expect(result.stderr).toContain('breaks rule 2: core imports no protocol group');
    expect(result.stderr).toContain('[core->compose] run/select.ts -> protocols.ts : registry');
    expect(result.stderr).toContain('breaks rule 3: nothing imports compose');
    expect(result.stderr).toContain('banned import: xml/parse.ts -> electron');
    expect(result.stderr).not.toContain('import/http-file/map.ts -> rest/model.ts');
  }, 30_000);

  it('finds no violation and no banned import in the engine itself', () => {
    const result = run(['--check']);

    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(
      /^engine layers: 0 violation\(s\), 0 banned import\(s\), \d+ import\(s\) from compose/,
    );
    expect(result.status).toBe(0);
  }, 30_000);
});

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function listSourceFiles(dir: string): string[] {
  const root = join(repoRoot, dir);
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(root, f));
}

describe('packages/ssh layering', () => {
  it('the engine and packages/ssh never import each other, and ssh never imports electron', () => {
    const engineFiles = listSourceFiles('packages/engine/src');
    const sshFiles = listSourceFiles('packages/ssh/src');
    expect(sshFiles.length).toBeGreaterThan(0);
    expect(engineFiles.filter((f) => readFileSync(f, 'utf8').includes("from '@wirebench/ssh"))).toEqual([]);
    expect(sshFiles.filter((f) => /from '(@wirebench\/engine|electron)/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
