/**
 * The order a new interface or API takes: one past the highest order any of the four kinds holds,
 * so it never repeats one still held, even after a delete has left a gap.
 */
import { describe, expect, it } from 'vitest';
import { createApi, createGrpcApi, createProject, createWsApi, nextApiOrder } from '../../../src/index.js';

describe('nextApiOrder', () => {
  it('is 0 for a project with no interface and no API', () => {
    expect(nextApiOrder(createProject('Empty', { id: 'p1' }))).toBe(0);
  });

  it('is one past the highest order of any kind, not the count', () => {
    const project = {
      ...createProject('Mixed', { id: 'p1' }),
      containers: {
        rest: [createApi('Shop', { id: 'a1', order: 1 })],
        grpc: [createGrpcApi('Pets', { id: 'g1', order: 2 })],
        websocket: [createWsApi('Chat', { id: 'w1', order: 5 })],
      },
    };
    expect(nextApiOrder(project)).toBe(6);
  });
});
