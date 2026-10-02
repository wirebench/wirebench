import { afterEach, describe, expect, it } from 'vitest';
import { projectStepRequests } from '../../src/renderer/features/sequence/step-requests.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import {
  grpcApiWire,
  grpcRequestWire,
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
});
