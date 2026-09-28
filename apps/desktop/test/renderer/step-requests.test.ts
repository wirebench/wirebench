import { afterEach, describe, expect, it } from 'vitest';
import { projectStepRequests } from '../../src/renderer/features/sequence/step-requests.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { restApiWire, restRequestWire } from '../helpers/wire-defaults.js';

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
});
