/**
 * The routing index's entity ids come from the kinds (`KIND_ENTITY_IDS`), so a kind added to the list
 * routes its entities without an edit to `WorkspaceService`.
 */
import { describe, expect, it } from 'vitest';
import { MAIN_KINDS } from '../src/kinds/kind-main.js';
import { KIND_ENTITY_IDS } from '../src/kinds/kind-routes.js';
import { kindEntityIds } from '../src/workspace-service.js';
import type { ProjectWire } from '@wirebench/wire/wire-types';
import {
  grpcApiWire,
  grpcRequestWire,
  restApiWire,
  restFolderWire,
  restRequestWire,
  wsApiWire,
  wsRequestWire,
} from '../../../apps/desktop/test/helpers/wire-defaults.js';

/** One entity of every kind's, with a folder under each kind's API and the webhook collection. */
const PROJECT = {
  id: 'p1',
  interfaces: [{ id: 'iface', endpoints: [{ id: 'endpoint' }] }],
  requests: [{ id: 'soap-request' }],
  apis: [restApiWire({ id: 'rest-api' })],
  folders: [
    restFolderWire({ id: 'rest-folder', apiId: 'rest-api' }),
    restFolderWire({ id: 'webhook-folder', apiId: 'hooks' }),
    restFolderWire({ id: 'grpc-folder', apiId: 'grpc-api' }),
    restFolderWire({ id: 'ws-folder', apiId: 'ws-api' }),
    restFolderWire({ id: 'mcp-folder', apiId: 'mcp-server' }),
  ],
  restRequests: [restRequestWire({ id: 'rest-request' })],
  webhooks: { id: 'hooks' },
  grpcApis: [grpcApiWire({ id: 'grpc-api' })],
  grpcRequests: [grpcRequestWire({ id: 'grpc-request' })],
  wsApis: [wsApiWire({ id: 'ws-api' })],
  wsRequests: [wsRequestWire({ id: 'ws-request' })],
  mcpServers: [{ id: 'mcp-server' }],
  mcpRequests: [{ id: 'mcp-request' }],
} as unknown as ProjectWire;

describe("the routing index's entity ids", () => {
  it('lists every entity of every built-in kind, each once', () => {
    const ids = [...kindEntityIds(PROJECT)];
    expect(ids.sort()).toEqual(
      [
        'iface',
        'endpoint',
        'soap-request',
        'rest-api',
        'hooks',
        'rest-folder',
        'webhook-folder',
        'rest-request',
        'grpc-api',
        'grpc-folder',
        'grpc-request',
        'ws-api',
        'ws-folder',
        'ws-request',
        'mcp-server',
        'mcp-folder',
        'mcp-request',
      ].sort(),
    );
  });

  it("routes an extra kind's ids without an edit to the index", () => {
    const extra = (): Iterable<string> => ['graph-api', 'graph-request'];
    const ids = [...kindEntityIds(PROJECT, [...Object.values(KIND_ENTITY_IDS), extra])];
    expect(ids).toEqual(expect.arrayContaining(['graph-api', 'graph-request', 'rest-api']));
  });

  it('is the lister each main kind carries', () => {
    for (const kind of MAIN_KINDS) {
      expect(kind.entityIds, kind.kind).toBe(KIND_ENTITY_IDS[kind.kind]);
    }
  });
});
