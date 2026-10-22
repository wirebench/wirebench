import { beforeEach, describe, expect, it } from 'vitest';
import type { Problem } from '../../src/renderer/state/problems.js';
import { countProblems, filterProblems, lintSummary, useProblemsStore } from '../../src/renderer/state/problems.js';

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

describe('countProblems', () => {
  function problem(groupId: string, source: Problem['source'], severity: Problem['severity']): Problem {
    return { groupId, source, severity, problem: { code: 'c', message: 'm' } };
  }

  it('counts lint findings apart from the problems, by severity', () => {
    expect(
      countProblems([
        problem('lint:api-1', 'lint', 'error'),
        problem('lint:api-1', 'lint', 'error'),
        problem('lint:api-1', 'lint', 'warning'),
        problem('lint:api-2', 'lint', 'warning'),
        problem('expansion:req-1', 'expansion', 'warning'),
        problem('iface-1', 'import', 'error'),
      ]),
    ).toEqual({ problems: 2, errors: 1, lintErrors: 2, lintWarnings: 2 });
  });

  it('leaves a failed SSH connect out of every count', () => {
    expect(countProblems([problem('ssh:host-1', 'send', 'error')])).toEqual({
      problems: 0,
      errors: 0,
      lintErrors: 0,
      lintWarnings: 0,
    });
  });

  it('counts nothing in an empty list', () => {
    expect(countProblems([])).toEqual({ problems: 0, errors: 0, lintErrors: 0, lintWarnings: 0 });
  });

  it('lists lint findings on their own, never under All, Errors or Warnings (#745)', () => {
    const items = [
      problem('lint:api-1', 'lint', 'error'),
      problem('lint:api-1', 'lint', 'warning'),
      problem('expansion:req-1', 'expansion', 'warning'),
      problem('iface-1', 'import', 'error'),
    ];
    expect(filterProblems(items, 'all').map((item) => item.source)).toEqual(['expansion', 'import']);
    expect(filterProblems(items, 'error').map((item) => item.groupId)).toEqual(['iface-1']);
    expect(filterProblems(items, 'warning').map((item) => item.groupId)).toEqual(['expansion:req-1']);
    expect(filterProblems(items, 'lint').map((item) => item.severity)).toEqual(['error', 'warning']);
  });

  it('starts on All and remembers the chip picked', () => {
    expect(useProblemsStore.getState().filter).toBe('all');
    useProblemsStore.getState().setFilter('lint');
    expect(useProblemsStore.getState().filter).toBe('lint');
  });
});

describe('lintSummary', () => {
  it('names both severities, singular or plural, and leaves out one with none', () => {
    expect(lintSummary(2, 55)).toBe('2 errors, 55 warnings');
    expect(lintSummary(1, 1)).toBe('1 error, 1 warning');
    expect(lintSummary(0, 3)).toBe('3 warnings');
    expect(lintSummary(4, 0)).toBe('4 errors');
    expect(lintSummary(0, 0)).toBe('');
  });
});
