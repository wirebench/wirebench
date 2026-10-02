/** WebSocket's run facet offers a run its requests, as REST does: every one but the orphaned ones. */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { ORPHANED_STEP_REASON } from '../../../src/run/tree.js';
import { createWsApi, createWsFolder, createWsRequest } from '../../../src/ws/model.js';
import { wsEffectiveAuth, wsItemFor, wsRun } from '../../../src/ws/run.js';
import type { WsSelected } from '../../../src/ws/run.js';

const ticker = createWsRequest('Ticker', { id: 'ws-ticker', slug: 'ticker', order: 0 });
const gone = { ...createWsRequest('Gone', { id: 'ws-gone', order: 1 }), orphaned: true };
const audit = createWsRequest('Audit', { id: 'ws-audit', slug: 'audit', auth: { type: 'inherit' } });
const admin = createWsFolder('Admin', {
  id: 'ws-admin',
  slug: 'admin',
  order: 2,
  auth: { type: 'bearer', tokenRef: 'ref-admin' },
  requests: [audit],
});
const feed = createWsApi('Feed', {
  id: 'api-feed',
  slug: 'feed',
  order: 3,
  auth: { type: 'bearer', tokenRef: 'ref-api' },
  requests: [ticker, gone],
  folders: [admin],
});
const project: Project = { ...createProject('WebSocket groups', { id: 'proj-ws' }), wsApis: [feed] };

describe('wsRun.groups', () => {
  it('lists every request of each API in explorer order, without the orphaned ones', () => {
    const groups = wsRun.groups(project);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ order: 3, name: 'Feed' });
    expect(groups[0]?.candidates).toEqual([
      {
        item: { kind: 'websocket', path: 'Feed/Ticker', group: 'Feed', api: feed, chain: [], request: ticker },
        diskPath: 'apis/feed/requests/ticker',
      },
      {
        item: {
          kind: 'websocket',
          path: 'Feed/Admin/Audit',
          group: 'Feed/Admin',
          api: feed,
          chain: [admin],
          request: audit,
        },
        diskPath: 'apis/feed/requests/admin/audit',
      },
    ]);
  });

  it('has nothing for a project without WebSocket APIs', () => {
    expect(wsRun.groups({ ...project, wsApis: [] })).toEqual([]);
  });
});

describe('wsRun.whyNotRunnable', () => {
  it('gives the orphaned reason for an orphaned request and none for any other', () => {
    expect(wsRun.whyNotRunnable(project, 'ws-gone')).toBe(ORPHANED_STEP_REASON);
    expect(wsRun.whyNotRunnable(project, 'ws-ticker')).toBeUndefined();
    expect(wsRun.whyNotRunnable(project, 'ws-audit')).toBeUndefined();
    expect(wsRun.whyNotRunnable(project, 'nowhere')).toBeUndefined();
  });
});

describe('wsRun.secretNeeds and wsEffectiveAuth', () => {
  const selected: WsSelected = {
    kind: 'websocket',
    path: 'Feed/Admin/Audit',
    group: 'Feed/Admin',
    api: feed,
    chain: [admin],
    request: audit,
  };

  it('inherits the innermost folder before the API', () => {
    expect(wsEffectiveAuth(selected)).toEqual({ type: 'bearer', tokenRef: 'ref-admin' });
  });

  it('needs the secret of the effective auth', () => {
    expect(wsRun.secretNeeds(selected, project).map((need) => need.ref)).toEqual(['ref-admin']);
  });

  it('has no script types to offer', async () => {
    await expect(wsRun.scriptTypes(selected, {} as never)).resolves.toEqual({ generated: '' });
  });
});

describe('wsItemFor', () => {
  it('finds a request inside a folder, and an orphaned one a run skips', () => {
    expect(wsItemFor(project, 'ws-audit')).toEqual({
      kind: 'websocket',
      path: 'Feed/Admin/Audit',
      group: 'Feed/Admin',
      api: feed,
      chain: [admin],
      request: audit,
    });
    expect(wsItemFor(project, 'ws-gone')?.request).toBe(gone);
  });

  it('has nothing for an id no WebSocket request has', () => {
    expect(wsItemFor(project, 'nowhere')).toBeUndefined();
  });
});
