import { describe, expect, it } from 'vitest';
import { KINDS } from '../../src/shared/kinds/kind-module.js';
import { RENDERER_KINDS, TAB_KINDS } from '../../src/renderer/kinds/index.js';
import { PERSISTED_TAB_KINDS } from '../../src/renderer/state/ui-state.js';
import { environmentTabId } from '../../src/renderer/features/environments/environment-actions.js';
import { grpcApiTabId } from '../../src/renderer/features/grpc-api/grpc-api-actions.js';
import { grpcTabId } from '../../src/renderer/features/grpc-editor/grpc-actions.js';
import { projectTabId } from '../../src/renderer/features/explorer/project-actions.js';
import { mockTabId } from '../../src/renderer/features/mock/mock-actions.js';
import { interfaceTabId } from '../../src/renderer/features/interface-editor/interface-actions.js';
import { restTabId } from '../../src/renderer/features/rest-editor/rest-actions.js';
import { catchUrlTabId } from '../../src/renderer/features/webhooks/webhooks-actions.js';
import { apiTabId } from '../../src/renderer/features/rest-api/api-actions.js';
import { wsApiTabId } from '../../src/renderer/features/ws-api/ws-api-actions.js';
import { sequenceTabId } from '../../src/renderer/features/sequence/sequence-actions.js';
import { wsTabId } from '../../src/renderer/features/ws-editor/ws-actions.js';
import { runnerTabId } from '../../src/renderer/features/runner/runner-actions.js';
import { mcpApiTabId } from '../../src/renderer/features/mcp-api/mcp-api-actions.js';
import { mcpTabId } from '../../src/renderer/features/mcp-editor/mcp-actions.js';

describe('renderer kinds (kind modules spec §6)', () => {
  it('has one renderer half per shared kind, in the same order', () => {
    expect(RENDERER_KINDS.map((kind) => kind.kind)).toEqual(KINDS.map((kind) => kind.kind));
  });

  it('gives each kind the request and container tabs its shared half names', () => {
    for (const kind of KINDS) {
      const renderer = RENDERER_KINDS.find((candidate) => candidate.kind === kind.kind);
      expect(renderer?.tabs.map((tab) => tab.kind).sort()).toEqual([kind.tabs.request, kind.tabs.container].sort());
    }
  });

  it('persists exactly the tab kinds the saved UI state accepts', () => {
    const persisted = Object.values(TAB_KINDS)
      .filter((tab) => tab?.persisted === true)
      .map((tab) => tab?.kind);
    expect(persisted.sort()).toEqual([...PERSISTED_TAB_KINDS].sort());
  });

  it('opens each tab under the id its feature opener uses', () => {
    const openers: Record<string, (id: string) => string> = {
      request: (id) => `request:${id}`,
      interface: interfaceTabId,
      'rest-request': restTabId,
      api: apiTabId,
      'grpc-request': grpcTabId,
      'grpc-api': grpcApiTabId,
      'ws-request': wsTabId,
      'ws-api': wsApiTabId,
      'mcp-request': mcpTabId,
      'mcp-api': mcpApiTabId,
      environment: (id) => environmentTabId({ kind: 'environment', id }),
      project: projectTabId,
      sequence: sequenceTabId,
      mock: mockTabId,
      history: (id) => `history:${id}`,
      'catch-url': catchUrlTabId,
      runner: runnerTabId,
    };
    expect(Object.keys(TAB_KINDS).sort()).toEqual(Object.keys(openers).sort());
    for (const [kind, opener] of Object.entries(openers)) {
      expect(`${TAB_KINDS[kind as keyof typeof TAB_KINDS]?.prefix ?? ''}x-1`).toBe(opener('x-1'));
    }
  });

  it('gives each explorer node kind at most one owning kind', () => {
    const owned = RENDERER_KINDS.flatMap((kind) => Object.keys(kind.explorer.nodes));
    expect(new Set(owned).size).toBe(owned.length);
  });

  it('lets every kind whose APIs hold folders make a request in one', () => {
    for (const kind of RENDERER_KINDS.filter((candidate) => candidate.kind !== 'soap')) {
      expect(kind.explorer.newRequestIn, kind.kind).toBeTypeOf('function');
    }
    // A cURL line describes an HTTP request: only REST takes one.
    expect(RENDERER_KINDS.filter((kind) => kind.explorer.importCurlIn !== undefined).map((kind) => kind.kind)).toEqual([
      'rest',
    ]);
  });
});
