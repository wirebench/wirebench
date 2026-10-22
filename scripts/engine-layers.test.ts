/**
 * The engine's dependency rules (package split spec §4), checked by the import-graph script: against a
 * fixture `packages/` tree that breaks each rule once, and against the real packages.
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

/**
 * A `packages/` tree with one import of each kind the rules tell apart: every package is a folder with a
 * manifest and a `src/`, as the real ones are.
 */
const FIXTURE: Readonly<Record<string, string>> = {
  'core/package.json': '{ "name": "@wirebench/core", "dependencies": { "zod": "4" } }\n',
  'core/src/http/entries.ts': 'export const shared = 1;\n',
  // Rule 2: core importing a protocol, and a type-only import breaks it too.
  'core/src/project/environments.ts':
    "import type { Interface } from '#protocol-soap/soap/model';\nexport interface Endpoints {\n  readonly of?: Interface;\n}\n",
  // Rule 3: core importing compose.
  'core/src/run/select.ts': "import { registry } from '@wirebench/engine';\nexport const selected = registry;\n",
  // An `import()` type is an import.
  'core/src/script/run.ts': "export type Api = import('#protocol-rest/rest/model').RestApi;\n",
  // A banned package.
  'core/src/xml/parse.ts': "import { app } from 'electron';\nexport const parse = app;\n",
  'protocol-rest/package.json':
    '{ "name": "@wirebench/protocol-rest", "dependencies": { "@wirebench/core": "workspace:*" } }\n',
  'protocol-rest/src/rest/model.ts': 'export interface RestApi {\n  readonly id: string;\n}\nexport const REST = 1;\n',
  // A protocol importing core and itself: allowed, and the core import is reported.
  'protocol-rest/src/rest/send.ts':
    "import { shared } from '#core/http/entries';\nimport { REST } from './model.js';\nexport const sent = shared + REST;\n",
  // Rule 1 broken in the manifest: a protocol listing another.
  'protocol-grpc/package.json':
    '{ "name": "@wirebench/protocol-grpc", "dependencies": { "@wirebench/core": "workspace:*", "@wirebench/protocol-rest": "workspace:*" } }\n',
  // Rule 1 in a file.
  'protocol-grpc/src/grpc/model.ts':
    "import type { RestApi } from '@wirebench/protocol-rest/rest/model';\nexport interface GrpcApi {\n  readonly rest: RestApi;\n}\n",
  'protocol-soap/package.json': '{ "name": "@wirebench/protocol-soap" }\n',
  'protocol-soap/src/soap/model.ts': 'export interface Interface {\n  readonly id: string;\n}\n',
  // A relative import that leaves its package: refused even where it would resolve.
  'protocol-soap/src/soap/send.ts':
    "import { shared } from '../../../core/src/http/entries.js';\nexport const sent = shared;\n",
  'engine/package.json':
    '{ "name": "@wirebench/engine", "devDependencies": { "@wirebench/core": "workspace:*", "@wirebench/protocol-rest": "workspace:*" } }\n',
  // Compose imports a protocol: allowed.
  'engine/src/protocols.ts': "import { REST } from '#protocol-rest/rest/model';\nexport const registry = REST;\n",
  'engine/src/import/http-file/map.ts':
    "import { REST } from '@wirebench/protocol-rest/rest/model';\nexport const mapped = REST;\n",
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

  it('reports every import that crosses a package, and which of them break a rule', () => {
    const result = run(['--root', fixture, '--json']);
    const report = JSON.parse(result.stdout) as Report;

    expect(report.unresolved).toEqual([]);
    expect(report.edges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual([
      'core/project/environments.ts -> #protocol-soap/soap/model',
      'core/run/select.ts -> @wirebench/engine',
      'core/script/run.ts -> #protocol-rest/rest/model',
      'protocol-soap/soap/send.ts -> core/src/http/entries.ts',
      'protocol-rest/package.json -> @wirebench/core',
      'protocol-rest/rest/send.ts -> #core/http/entries',
      'protocol-grpc/package.json -> @wirebench/core',
      'protocol-grpc/package.json -> @wirebench/protocol-rest',
      'protocol-grpc/grpc/model.ts -> @wirebench/protocol-rest/rest/model',
      'engine/package.json -> @wirebench/core',
      'engine/package.json -> @wirebench/protocol-rest',
      'engine/import/http-file/map.ts -> @wirebench/protocol-rest/rest/model',
      'engine/protocols.ts -> #protocol-rest/rest/model',
    ]);
    expect(report.violations.map((edge) => edge.from)).toEqual([
      'core/project/environments.ts',
      'core/run/select.ts',
      'core/script/run.ts',
      'protocol-soap/soap/send.ts',
      'protocol-grpc/package.json',
      'protocol-grpc/grpc/model.ts',
    ]);
    expect(report.banned).toEqual([{ from: 'core/xml/parse.ts', specifier: 'electron' }]);
  }, 30_000);

  it('exits non-zero under --check and names the rule each import breaks', () => {
    const result = run(['--root', fixture, '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '[grpc->rest] protocol-grpc/grpc/model.ts -> @wirebench/protocol-rest/rest/model : RestApi (type-only)',
    );
    expect(result.stderr).toContain(
      '[grpc->rest] protocol-grpc/package.json -> @wirebench/protocol-rest : (dependency)',
    );
    expect(result.stderr).toContain('breaks rule 1: no other protocol');
    expect(result.stderr).toContain(
      '[core->soap] core/project/environments.ts -> #protocol-soap/soap/model : Interface (type-only)',
    );
    expect(result.stderr).toContain('breaks rule 2: core imports no protocol');
    expect(result.stderr).toContain('[core->compose] core/run/select.ts -> @wirebench/engine : registry');
    expect(result.stderr).toContain('breaks rule 3: nothing imports compose');
    expect(result.stderr).toContain('[soap->core] protocol-soap/soap/send.ts -> core/src/http/entries.ts : shared');
    expect(result.stderr).toContain('breaks a relative import never leaves its package');
    expect(result.stderr).toContain('banned import: core/xml/parse.ts -> electron');
    expect(result.stderr).not.toContain('engine/import/http-file/map.ts');
    expect(result.stderr).not.toContain('protocol-rest/rest/send.ts');
  }, 30_000);

  it('finds no violation and no banned import in the engine itself', () => {
    const result = run(['--check']);

    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(
      /^engine layers: 0 violation\(s\), 0 banned import\(s\), \d+ allowed import\(s\) across packages/,
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
    const engineFiles = [
      'core',
      'protocol-soap',
      'protocol-rest',
      'protocol-grpc',
      'protocol-ws',
      'protocol-mcp',
      'engine',
    ].flatMap((pkg) => listSourceFiles(`packages/${pkg}/src`));
    const sshFiles = listSourceFiles('packages/ssh/src');
    expect(sshFiles.length).toBeGreaterThan(0);
    expect(engineFiles.filter((f) => readFileSync(f, 'utf8').includes("from '@wirebench/ssh"))).toEqual([]);
    expect(sshFiles.filter((f) => /from '(@wirebench\/engine|electron)/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
