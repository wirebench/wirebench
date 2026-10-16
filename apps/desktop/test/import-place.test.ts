import { describe, expect, it, vi } from 'vitest';
import { placeMappedImport } from '../src/main/import-place.js';

const emptyReport = { warnings: [], notes: [] };
const emptyPlan = { environments: [], report: emptyReport };

function makeDeps(overrides: { writeImportedScripts?: ReturnType<typeof vi.fn> } = {}) {
  const calls: string[] = [];
  const router = {
    addApi: vi.fn(() => {
      calls.push('rest');
      return { project: { id: 'p' }, apiId: 'rest-1' };
    }),
    importGrpcApi: vi.fn(() => {
      calls.push('grpc');
      return { project: { id: 'p' }, apiId: 'grpc-1' };
    }),
    importWsApi: vi.fn(() => {
      calls.push('ws');
      return { project: { id: 'p' }, apiId: 'ws-1' };
    }),
    writeImportedScripts:
      overrides.writeImportedScripts ?? vi.fn(() => Promise.resolve({ written: [], renamed: [], skipped: [] })),
  };
  const variablesPorts = vi.fn();
  return { calls, router, variablesPorts, deps: { router, variablesPorts } as never };
}

const meta = { source: '/src', declaredVersion: 'v' };
const api = (name: string) => ({ name }) as never;

describe('placeMappedImport', () => {
  it('places rest, grpc and websocket APIs in order', async () => {
    const { calls, deps } = makeDeps();
    const result = await placeMappedImport(
      deps,
      'proj',
      {
        collections: [
          { name: 'a', rest: api('a'), grpc: api('a'), websocket: api('a') },
          { name: 'b', rest: api('b') },
        ],
        variables: emptyPlan,
        report: emptyReport,
      },
      meta,
    );
    expect(calls).toEqual(['rest', 'grpc', 'ws', 'rest']);
    expect(result.apiIds).toEqual(['rest-1', 'grpc-1', 'ws-1', 'rest-1']);
    expect(result.projectId).toBe('proj');
  });

  it('applies variables only when the plan has some', async () => {
    const { deps, variablesPorts } = makeDeps();
    const result = await placeMappedImport(
      deps,
      'proj',
      { collections: [], variables: emptyPlan, report: emptyReport },
      meta,
    );
    expect(variablesPorts).not.toHaveBeenCalled();
    expect(result.variables).toBeUndefined();
  });

  it('writes scripts and reports a renamed one', async () => {
    const writeImportedScripts = vi.fn(() =>
      Promise.resolve({
        written: ['imported-scripts/a/x-2.pre.js', 'imported-scripts/a/y.pre.js'],
        renamed: [{ from: 'imported-scripts/a/x.pre.js', to: 'imported-scripts/a/x-2.pre.js' }],
        skipped: ['../evil.js'],
      }),
    );
    const { deps } = makeDeps({ writeImportedScripts });
    const result = await placeMappedImport(
      deps,
      'proj',
      {
        collections: [],
        variables: emptyPlan,
        report: emptyReport,
        scripts: [
          { path: 'imported-scripts/a/x.pre.js', source: '1' },
          { path: 'imported-scripts/a/y.pre.js', source: '2' },
        ],
      },
      meta,
    );
    expect(result.scripts).toBe(2);
    expect(result.notes).toEqual([
      'A script already existed at imported-scripts/a/x.pre.js, so this one was saved as imported-scripts/a/x-2.pre.js.',
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.reportText).toContain('Note: A script already existed');
  });

  it('merges mapped and variable reports', async () => {
    const { deps } = makeDeps();
    const result = await placeMappedImport(
      deps,
      'proj',
      {
        collections: [],
        variables: { environments: [], report: { warnings: ['vw'], notes: ['vn'] } },
        report: { warnings: ['mw'], notes: ['mn'] },
      },
      meta,
    );
    expect(result.warnings).toEqual(['mw', 'vw']);
    expect(result.notes).toEqual(['mn', 'vn']);
  });
});
