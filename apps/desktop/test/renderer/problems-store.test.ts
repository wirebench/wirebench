import { beforeEach, describe, expect, it } from 'vitest';
import type { Problem } from '../../src/renderer/state/problems.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';

function expansion(requestId: string, message: string): Problem {
  return {
    groupId: `expansion:${requestId}`,
    source: 'expansion',
    severity: 'warning',
    requestId,
    problem: { code: 'expansion-missing', message },
  };
}

describe('useProblemsStore', () => {
  beforeEach(() => {
    useProblemsStore.setState({ items: [] });
  });

  it('set() replaces one group of import problems and tags them', () => {
    useProblemsStore.getState().set('iface-1', [{ source: 'wsdl', code: 'x', message: 'first' }]);
    useProblemsStore.getState().set('iface-2', [{ source: 'schema', code: 'y', message: 'other' }]);
    useProblemsStore.getState().set('iface-1', [{ source: 'wsdl', code: 'x', message: 'second' }]);

    expect(useProblemsStore.getState().items.map((item) => item.problem.message)).toEqual(['other', 'second']);
    expect(useProblemsStore.getState().items[0]).toMatchObject({ source: 'import', severity: 'error' });
  });

  it('clearSource() drops one source, optionally narrowed to a single request', () => {
    useProblemsStore.getState().set('iface-1', [{ source: 'wsdl', code: 'x', message: 'import problem' }]);
    useProblemsStore.getState().add([expansion('req-1', 'a'), expansion('req-2', 'b')]);

    useProblemsStore.getState().clearSource('expansion', 'req-1');
    expect(useProblemsStore.getState().items.map((item) => item.problem.message)).toEqual(['import problem', 'b']);

    useProblemsStore.getState().clearSource('expansion');
    expect(useProblemsStore.getState().items.map((item) => item.problem.message)).toEqual(['import problem']);
  });

  it('clear() drops a whole group whatever its source', () => {
    useProblemsStore.getState().add([expansion('req-1', 'a')]);
    useProblemsStore.getState().clear('expansion:req-1');
    expect(useProblemsStore.getState().items).toEqual([]);
  });
});
