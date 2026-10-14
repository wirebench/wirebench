import { afterEach, describe, expect, it } from 'vitest';
import { projectStepRequests, stepRequestInfo } from '../../src/renderer/features/sequence/step-requests.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import {
  grpcApiWire,
  grpcRequestWire,
  mcpRequestWire,
  mcpServerWire,
  restApiWire,
  restRequestWire,
  wsApiWire,
  wsRequestWire,
} from '../helpers/wire-defaults.js';

describe('projectStepRequests', () => {
  afterEach(() => {
    useProjectStore.getState().reset();
  });

  it('leaves out webhook items: the engine refuses one as a sequence step', () => {
    useProjectStore.setState({
      apis: { 'api-1': restApiWire({ id: 'api-1', name: 'Petstore' }) },
      restRequests: {
        r1: restRequestWire({ id: 'r1', apiId: 'api-1', name: 'Get pet' }),
        r2: restRequestWire({ id: 'r2', apiId: 'webhooks:p1', name: 'Order paid', method: 'POST' }),
      },
      projectOf: { r1: 'p1', r2: 'p1' },
    });

    const info = projectStepRequests(useProjectStore.getState(), 'p1');

    expect(info.map((entry) => entry.requestId)).toEqual(['r1']);
  });

  it('offers a WebSocket request and a streaming gRPC call as steps, and refuses only an orphaned one', () => {
    useProjectStore.setState({
      grpcApis: { 'g-1': grpcApiWire({ id: 'g-1', name: 'Greeter' }) },
      grpcRequests: {
        g1: grpcRequestWire({ id: 'g1', apiId: 'g-1', name: 'Chat', methodKind: 'bidi-streaming' }),
        g2: grpcRequestWire({ id: 'g2', apiId: 'g-1', name: 'Feed', methodKind: 'server-streaming' }),
      },
      wsApis: { 'w-1': wsApiWire({ id: 'w-1', name: 'Live' }) },
      wsRequests: {
        w1: wsRequestWire({ id: 'w1', apiId: 'w-1', name: 'Echo' }),
        w2: wsRequestWire({ id: 'w2', apiId: 'w-1', name: 'Old', orphaned: true }),
      },
      projectOf: { g1: 'p1', g2: 'p1', w1: 'p1', w2: 'p1' },
    });

    const info = projectStepRequests(useProjectStore.getState(), 'p1');
    const byId = Object.fromEntries(info.map((entry) => [entry.requestId, entry]));

    for (const id of ['g1', 'g2', 'w1']) {
      expect(byId[id]).toBeDefined();
      expect(byId[id]).not.toHaveProperty('unsupported');
    }
    expect(byId['w2']?.unsupported).toBe('This request is no longer in its contract');
  });

  it('offers an MCP request as a step, badged MCP and placed by the tool, prompt or resource it names', () => {
    useProjectStore.setState({
      mcpServers: { 'mcp-api-1': mcpServerWire({ id: 'mcp-api-1', name: 'Files' }) },
      mcpRequests: {
        m1: mcpRequestWire({
          id: 'm1',
          name: 'Read a file',
          operation: { method: 'tools/call', tool: 'read_file', arguments: '{}' },
        }),
        m2: mcpRequestWire({ id: 'm2', name: 'List tools', operation: { method: 'tools/list' } }),
        m3: mcpRequestWire({
          id: 'm3',
          name: 'Notes',
          operation: { method: 'resources/read', uri: 'file:///notes.md' },
        }),
        m4: mcpRequestWire({
          id: 'm4',
          name: 'Untitled',
          operation: { method: 'prompts/get', prompt: '', arguments: [] },
        }),
        other: mcpRequestWire({ id: 'other', name: 'Elsewhere' }),
      },
      projectOf: { m1: 'p1', m2: 'p1', m3: 'p1', m4: 'p1', other: 'p2' },
    });

    const info = projectStepRequests(useProjectStore.getState(), 'p1');

    expect(info).toEqual([
      { requestId: 'm4', name: 'Untitled', badge: 'MCP', path: 'Files' },
      { requestId: 'm3', name: 'Notes', badge: 'MCP', path: 'Files/file:///notes.md' },
      { requestId: 'm1', name: 'Read a file', badge: 'MCP', path: 'Files/read_file' },
      { requestId: 'm2', name: 'List tools', badge: 'MCP', path: 'Files/tools/list' },
    ]);
    expect(stepRequestInfo(useProjectStore.getState(), 'other')).toMatchObject({ name: 'Elsewhere', badge: 'MCP' });
  });
});
