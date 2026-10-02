/** WebSocket as a module: registered, its run facet offers every request, and any can be a sequence step. */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { createWsApi, createWsFolder, createWsRequest } from '../../../src/ws/model.js';
import { wsProtocol } from '../../../src/ws/module.js';

const project: Project = {
  ...createProject('WebSocket module', { id: 'proj-ws' }),
  wsApis: [
    createWsApi('Feed', {
      id: 'api-feed',
      requests: [createWsRequest('Ticker', { id: 'ws-ticker' })],
      folders: [
        createWsFolder('Admin', {
          id: 'ws-admin',
          order: 1,
          requests: [createWsRequest('Audit', { id: 'ws-audit' })],
        }),
      ],
    }),
  ],
};

describe('wsProtocol', () => {
  it('is the websocket kind behind the websocket feature', () => {
    expect(wsProtocol.kind).toBe('websocket');
    expect(wsProtocol.feature).toEqual({
      id: 'websocket',
      title: 'WebSocket',
      default: true,
      stage: 'stable',
      requires: [],
    });
  });

  it('offers a run every request, wherever it sits in the tree', () => {
    expect(wsProtocol.run?.groups(project).flatMap((group) => group.candidates.map((c) => c.item.path))).toEqual([
      'Feed/Ticker',
      'Feed/Admin/Audit',
    ]);
  });

  it('gives no reason a WebSocket request cannot be a sequence step, wherever it sits in the tree', () => {
    expect(wsProtocol.run?.whyNotRunnable(project, 'ws-ticker')).toBeUndefined();
    expect(wsProtocol.run?.whyNotRunnable(project, 'ws-audit')).toBeUndefined();
    expect(wsProtocol.run?.whyNotRunnable(project, 'nowhere')).toBeUndefined();
  });
});
