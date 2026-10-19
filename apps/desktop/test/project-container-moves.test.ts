/**
 * Moving an API (#701): reordering it among its project's APIs, and taking it out of one project to
 * place it in another with every id kept.
 */
import { describe, expect, it } from 'vitest';
import {
  createApi,
  createFolder,
  createGrpcApi,
  createMock,
  createProject,
  createRestRequest,
  createWsApi,
  ProjectError,
} from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { holdsApi, placeApi, reorderApi, takeApi } from '../src/main/project-container-moves.js';
import { applyChange } from '../src/main/project-mutations.js';

/** The project's API ids, in explorer order. */
function apiOrder(project: Project): string[] {
  return Object.entries(project.containers)
    .filter(([kind]) => kind !== 'soap')
    .flatMap(([, list]) => list)
    .sort((a, b) => a.order - b.order)
    .map((container) => container.id);
}

/** Three APIs of three kinds: rest-1 (0), grpc-1 (1), ws-1 (2), and a mock of rest-1. */
function source(): Project {
  return {
    ...createProject('Source', { id: 'p-src' }),
    containers: {
      rest: [
        createApi('Pets', {
          id: 'rest-1',
          order: 0,
          folders: [
            createFolder('Admin', {
              id: 'f-admin',
              requests: [createRestRequest('Delete pet', { id: 'r-delete' })],
            }),
          ],
          requests: [createRestRequest('List pets', { id: 'r-list' })],
        }),
      ],
      grpc: [createGrpcApi('Greeter', { id: 'grpc-1', order: 1, target: 'localhost:50051' })],
      websocket: [createWsApi('Chat', { id: 'ws-1', order: 2, url: 'ws://localhost' })],
    },
    mocks: [createMock('Pets mock', { containerId: 'rest-1' }, { id: 'm-1', order: 0 })],
  };
}

function target(): Project {
  return {
    ...createProject('Target', { id: 'p-tgt' }),
    containers: { rest: [createApi('Pets', { id: 'rest-9', order: 4 })] },
    mocks: [createMock('Pets mock', { containerId: 'rest-9' }, { id: 'm-9', order: 3 })],
  };
}

describe('reorderApi', () => {
  it('moves an API before another, across kinds', () => {
    expect(apiOrder(reorderApi(source(), 'ws-1', 'rest-1'))).toEqual(['ws-1', 'rest-1', 'grpc-1']);
  });

  it('moves an API last when no API follows the drop', () => {
    expect(apiOrder(reorderApi(source(), 'rest-1'))).toEqual(['grpc-1', 'ws-1', 'rest-1']);
  });

  it('hands the existing order values out again, so interfaces keep their places', () => {
    const project = reorderApi(source(), 'rest-1');
    const orders = Object.values(project.containers)
      .flat()
      .map((container) => container.order)
      .sort();
    expect(orders).toEqual([0, 1, 2]);
  });

  it('returns the same project when nothing moves', () => {
    const project = source();
    expect(reorderApi(project, 'rest-1', 'grpc-1')).toBe(project);
    expect(reorderApi(project, 'rest-1', 'rest-1')).toBe(project);
  });

  it('separates APIs that share an order value', () => {
    const project: Project = {
      ...source(),
      containers: {
        rest: [createApi('A', { id: 'a', order: 0 }), createApi('B', { id: 'b', order: 0 })],
      },
    };
    expect(apiOrder(reorderApi(project, 'b', 'a'))).toEqual(['b', 'a']);
  });

  it('refuses an id that names no API', () => {
    expect(() => reorderApi(source(), 'nope')).toThrow(ProjectError);
    expect(() => reorderApi(source(), 'rest-1', 'nope')).toThrow(ProjectError);
  });

  it('is the move-container change', async () => {
    const { project } = await applyChange(
      source(),
      { kind: 'move-container', apiId: 'ws-1', beforeApiId: 'grpc-1' },
      { generate: () => Promise.reject(new Error('unused')) },
    );
    expect(apiOrder(project)).toEqual(['rest-1', 'ws-1', 'grpc-1']);
  });
});

describe('takeApi and placeApi', () => {
  it('takes the API and its mocks out of the source', () => {
    const { project, slice } = takeApi(source(), 'rest-1');
    expect(holdsApi(project, 'rest-1')).toBe(false);
    expect(project.containers['rest']).toBeUndefined();
    expect(project.mocks).toEqual([]);
    expect(slice.kind).toBe('rest');
    expect(slice.mocks.map((mock) => mock.id)).toEqual(['m-1']);
  });

  it('places it in the target with every id kept, last, under free slugs', () => {
    const { slice } = takeApi(source(), 'rest-1');
    const placed = placeApi(target(), slice);
    const api = placed.containers['rest']?.find((container) => container.id === 'rest-1');
    expect(api).toBeDefined();
    expect(api?.slug).not.toBe(slice.container.slug);
    expect(api?.order).toBe(5);
    expect(JSON.stringify(api)).toContain('r-delete');
    expect(JSON.stringify(api)).toContain('f-admin');
    const mock = placed.mocks.find((candidate) => candidate.id === 'm-1');
    expect(mock?.slug).not.toBe('Pets-mock');
    expect(mock?.slug).not.toBe(slice.mocks[0]?.slug);
    expect(mock?.order).toBe(4);
    expect(mock?.source.containerId).toBe('rest-1');
  });

  it('places it before another API when asked', () => {
    const { slice } = takeApi(source(), 'grpc-1');
    expect(apiOrder(placeApi(target(), slice, 'rest-9'))).toEqual(['grpc-1', 'rest-9']);
  });

  it('refuses a target that already holds the API', () => {
    const { slice } = takeApi(source(), 'rest-1');
    expect(() => placeApi(source(), slice)).toThrow(/already holds/);
  });

  it('round-trips: moving it back gives the source its API again', () => {
    const taken = takeApi(source(), 'ws-1');
    const there = placeApi(target(), taken.slice);
    const back = takeApi(there, 'ws-1');
    const home = placeApi(taken.project, back.slice);
    expect(holdsApi(home, 'ws-1')).toBe(true);
    expect(holdsApi(back.project, 'ws-1')).toBe(false);
  });
});
