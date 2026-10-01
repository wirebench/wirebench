/** WebSocket as a module: registered, never selected, and a reason for a sequence step. */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import type { RunScope, SelectedBase } from '../../../src/protocol/module.js';
import { createWsApi, createWsFolder, createWsRequest } from '../../../src/ws/model.js';
import { wsProtocol } from '../../../src/ws/module.js';
import { testHost } from '../../helpers/send-host.js';

const project: Project = {
  ...createProject('WebSocket module', { id: 'proj-ws' }),
  wsApis: [
    createWsApi('Feed', {
      id: 'api-feed',
      requests: [createWsRequest('Ticker', { id: 'ws-ticker' })],
      folders: [createWsFolder('Admin', { id: 'ws-admin', requests: [createWsRequest('Audit', { id: 'ws-audit' })] })],
    }),
  ],
};

const selected: SelectedBase = {
  kind: 'websocket',
  path: 'Feed/Ticker',
  group: 'Feed',
  request: { id: 'ws-ticker', name: 'Ticker', slug: 'ticker' },
};

const host = testHost();
const scope = { context: { project, projectDir: '/nowhere', overrides: {} } } as RunScope;

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

  it('offers a run no request', () => {
    expect(wsProtocol.run?.groups(project)).toEqual([]);
  });

  it('says why a WebSocket request cannot be a sequence step, wherever it sits in the tree', () => {
    expect(wsProtocol.run?.whyNotRunnable(project, 'ws-ticker')).toBe('A WebSocket request cannot be a sequence step');
    expect(wsProtocol.run?.whyNotRunnable(project, 'ws-audit')).toBe('A WebSocket request cannot be a sequence step');
    expect(wsProtocol.run?.whyNotRunnable(project, 'nowhere')).toBeUndefined();
  });

  it('cannot send, type or list needs: nothing ever reaches it', async () => {
    const message = 'A run cannot send a WebSocket request';
    await expect(wsProtocol.run?.open(selected, scope, host, { scope, interactive: false }).result).rejects.toThrow(
      message,
    );
    await expect(wsProtocol.run?.resolve(selected, scope, host)).rejects.toThrow(message);
    await expect(wsProtocol.run?.scriptTypes(selected, scope)).rejects.toThrow(message);
    expect(() => wsProtocol.run?.secretNeeds(selected, project)).toThrow(message);
  });
});
