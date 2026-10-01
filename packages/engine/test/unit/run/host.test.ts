import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunSender } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { testHost } from '../../helpers/send-host.js';

describe('RunContext.host', () => {
  it('reads secrets through the host', async () => {
    const asked: string[] = [];
    const api = createApi('A', {
      baseUrl: 'http://127.0.0.1:1',
      auth: { type: 'bearer', tokenRef: 'tok' },
      requests: [createRestRequest('Get', { url: '/x' })],
    });
    const project = { ...createProject('P'), apis: [api] };
    const context: RunContext = {
      project,
      projectDir: '/nowhere',
      overrides: {},
      host: testHost({}, { getSecret: (ref) => (asked.push(ref), Promise.resolve('v')) }),
    };
    const [item] = selectRequests(project, []).selected;
    // Port 1 refuses the connection; the secret is read before that.
    await createRunSender(context)(item!).catch(() => undefined);
    expect(asked).toEqual(['tok']);
  });
});
