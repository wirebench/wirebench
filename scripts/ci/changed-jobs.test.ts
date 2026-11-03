import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changedJobs, JOBS, readWorkspace } from './changed-jobs.js';

const workspace = readWorkspace(fileURLToPath(new URL('../..', import.meta.url)));
const ALL_JOBS = Object.keys(JOBS).sort();

/** The jobs these files call for, sorted; `code` left out. */
function called(...files: string[]): string[] {
  return Object.entries(changedJobs(files, workspace))
    .filter(([key, value]) => key !== 'code' && value)
    .map(([key]) => key)
    .sort();
}

describe('changedJobs', () => {
  it('calls for nothing on documentation alone', () => {
    expect(changedJobs(['docs/a.md', 'site/src/index.astro', 'README.md', 'docs-site/x.mdx'], workspace)).toEqual({
      code: false,
      ...Object.fromEntries(ALL_JOBS.map((job) => [job, false])),
    });
  });

  it('runs the server jobs, and the two that build its image, for a server change, but not e2e', () => {
    expect(called('packages/server/src/routes.ts')).toEqual([
      'browser_e2e',
      'server_integration',
      'server_upgrade',
      'tenancy_postgres',
    ]);
  });

  it('runs e2e and the server image jobs for a desktop change, but not the server suites', () => {
    expect(called('apps/desktop/src/renderer/app.tsx')).toEqual(['browser_e2e', 'e2e', 'server_upgrade']);
  });

  it('runs the CLI jobs for a CLI change', () => {
    expect(called('packages/cli/src/bin.ts')).toEqual(['action_smoke', 'browser_e2e', 'image_smoke', 'npm_smoke']);
  });

  it('runs every job for a change to core, which everything depends on', () => {
    expect(called('packages/core/src/index.ts')).toEqual(ALL_JOBS);
  });

  it('keeps e2e and the browser suite apart', () => {
    expect(called('e2e/specs/a11y.spec.ts')).toEqual(['e2e']);
    expect(called('e2e/browser/specs/login.spec.ts')).toEqual(['browser_e2e']);
  });

  it('runs a job for the scripts it names, and nothing for the others', () => {
    expect(called('scripts/wss-xmlsec-check.ts')).toEqual(['wss_xmlsec']);
    expect(called('action/action.yml')).toEqual(['action_smoke']);
    expect(called('scripts/check-banned-terms.ts')).toEqual([]);
    expect(changedJobs(['scripts/check-banned-terms.ts'], workspace)['code']).toBe(true);
  });

  it('runs everything for what it cannot place', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'package.json',
      'vitest.config.ts',
      '.github/workflows/ci.yml',
      'fixtures/wsdl/a.wsdl',
      'packages/not-a-package-yet/src/a.ts',
    ]) {
      expect(called(file), file).toEqual(ALL_JOBS);
    }
  });

  it('follows the workspace dependencies it reads', () => {
    const toy = [
      { name: '@wirebench/server', dir: 'packages/server/', deps: ['@wirebench/new'] },
      { name: '@wirebench/new', dir: 'packages/new/', deps: [] },
    ];
    expect(changedJobs(['packages/new/src/a.ts'], toy)['server_integration']).toBe(true);
    expect(changedJobs(['packages/new/src/a.ts'], toy)['e2e']).toBe(false);
  });
});
