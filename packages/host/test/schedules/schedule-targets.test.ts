// @vitest-environment node
/**
 * What a schedule can pick (#517): the project's APIs, folders and requests as run selectors, and what
 * **Schedule…** on an explorer row fills in.
 */
import { describe, expect, it } from 'vitest';
import {
  createApi,
  createFolder,
  createProject,
  createRestRequest,
  createSequence,
  createSequenceStep,
} from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { scheduleChoices, scheduleTargetFor } from '../../src/schedules/targets.js';

function project(): Project {
  return {
    ...createProject('Shop', { id: 'P1' }),
    containers: {
      rest: [
        createApi('Shop', {
          id: 'A1',
          requests: [createRestRequest('top', { id: 'top', order: 0, url: '/top' })],
          folders: [
            createFolder('Users', {
              id: 'F1',
              order: 1,
              requests: [
                createRestRequest('one', { id: 'one', order: 0, url: '/one' }),
                createRestRequest('two', { id: 'two', order: 1, url: '/two' }),
              ],
            }),
          ],
        }),
      ],
    },
    sequences: [createSequence('Flow', { id: 'S1', steps: [createSequenceStep('one', { id: 'T1' })] })],
  };
}

describe('scheduleChoices', () => {
  it('lists the API, its folders and requests in explorer order, each by its display path', () => {
    const { items, sequences } = scheduleChoices(project());
    expect(items.map((item) => [item.kind, item.label, item.depth, item.selectors])).toEqual([
      ['api', 'Shop', 0, ['Shop']],
      ['request', 'top', 1, ['Shop/top']],
      ['folder', 'Users', 1, ['Shop/Users']],
      ['request', 'one', 2, ['Shop/Users/one']],
      ['request', 'two', 2, ['Shop/Users/two']],
    ]);
    expect(sequences).toEqual(['Flow']);
  });
});

describe('scheduleTargetFor', () => {
  it('runs the whole project from its row', () => {
    expect(scheduleTargetFor(project(), 'P1')).toEqual({ project: 'P1' });
  });

  it('runs one sequence by name', () => {
    expect(scheduleTargetFor(project(), 'S1')).toEqual({ project: 'P1', sequences: ['Flow'] });
  });

  it('runs a folder or a request by its selectors', () => {
    expect(scheduleTargetFor(project(), 'F1')).toEqual({ project: 'P1', select: ['Shop/Users'] });
    expect(scheduleTargetFor(project(), 'two')).toEqual({ project: 'P1', select: ['Shop/Users/two'] });
  });

  it('names nothing for an id no row has', () => {
    expect(scheduleTargetFor(project(), 'nope')).toBeUndefined();
  });
});
