import { join } from 'node:path';
import { loadProject, selectRequests } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'runner-project');

describe('runner-project fixture', () => {
  it('loads cleanly and has ten runnable requests', async () => {
    const { project, problems } = await loadProject(FIXTURE);
    expect(problems).toEqual([]);
    expect(selectRequests(project, []).selected.map((s) => s.path)).toEqual([
      'Echo/Echo/Say hello',
      'Echo/Echo/Secured hello',
      'demo/ok',
      'demo/slow',
      'demo/broken',
      'demo/secure',
      'demo/echo',
      'greeter/hello',
      'greeter/missing',
      'oauth/profile',
    ]);
  });
});
