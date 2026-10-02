import { describe, expect, it } from 'vitest';
import type { SendAuth } from '../../../src/http/auth/send-auth.js';
import { createProject } from '../../../src/project/model.js';
import type { AuthConfig } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { scopesFor, type RunContext } from '../../../src/run/context.js';
import { createRunSender } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { reportedAuth } from '../../../src/run/send-helpers.js';
import { testHost } from '../../helpers/send-host.js';

/** A context for one REST request with `auth`, aimed at port 1 where nothing listens. */
function contextWith(auth: AuthConfig, extra: Partial<RunContext['host']> = {}, secret = 'v'): RunContext {
  const api = createApi('A', {
    baseUrl: 'http://127.0.0.1:1',
    auth,
    requests: [createRestRequest('Get', { url: '/x' })],
  });
  const project = { ...createProject('P'), apis: [api] };
  return {
    project,
    projectDir: '/nowhere',
    overrides: {},
    host: testHost({}, { getSecret: () => Promise.resolve(secret), ...extra }),
  };
}

describe('RunContext.host', () => {
  it('reads secrets through the host', async () => {
    const asked: string[] = [];
    const context = contextWith(
      { type: 'bearer', tokenRef: 'tok' },
      {
        getSecret: (ref) => (asked.push(ref), Promise.resolve('v')),
      },
    );
    const [item] = selectRequests(context.project, []).selected;
    // Port 1 refuses the connection; the secret is read before that.
    await createRunSender(context)(item!).catch(() => undefined);
    expect(asked).toEqual(['tok']);
  });

  it('tells the host the credential a send puts on the wire, for masking', async () => {
    const reported: string[] = [];
    const context = contextWith(
      { type: 'bearer', tokenRef: 'tok' },
      { onSecretValue: (v) => reported.push(v) },
      'bearer-1',
    );
    const [item] = selectRequests(context.project, []).selected;
    await createRunSender(context)(item!).catch(() => undefined);
    expect(reported).toEqual(['bearer-1']);
  });
});

describe('reportedAuth', () => {
  function reportsOf(auth: SendAuth | undefined): string[] {
    const reported: string[] = [];
    const context = contextWith({ type: 'none' }, { onSecretValue: (v) => reported.push(v) });
    expect(reportedAuth(auth, context)).toBe(auth);
    return reported;
  }

  it('reports each credential in the form it travels, as the app records it', () => {
    expect(reportsOf({ type: 'api-key', name: 'X-Key', value: 'k-1', in: 'header' })).toEqual(['k-1']);
    expect(reportsOf({ type: 'bearer', token: 'b-1' })).toEqual(['b-1']);
    expect(reportsOf({ type: 'oauth2', accessToken: 'o-1' })).toEqual(['o-1']);
    expect(reportsOf({ type: 'basic', username: 'ann', password: 'pw', preemptive: true })).toEqual([
      Buffer.from('ann:pw', 'utf-8').toString('base64'),
    ]);
  });

  it('never reports a bare password, nor anything for NTLM or no auth', () => {
    expect(reportsOf({ type: 'ntlm', username: 'ann', password: 'pw' })).toEqual([]);
    expect(reportsOf(undefined)).toEqual([]);
  });
});

describe('RunContext.globals', () => {
  it('resolves the ${#Global#…} scope from the host', () => {
    const context: RunContext = { ...contextWith({ type: 'none' }), globals: { x: 'g' } };
    expect(scopesFor(context).global).toEqual({ x: 'g' });
    expect(scopesFor(contextWith({ type: 'none' })).global).toEqual({});
  });

  it('resolves the same scope inside a workspace', () => {
    const base = contextWith({ type: 'none' });
    const context: RunContext = {
      ...base,
      globals: { x: 'g' },
      workspace: {
        projectSlug: 'p',
        workspace: {
          formatVersion: 3,
          id: 'ws',
          name: 'WS',
          createdAt: '2026-10-01T00:00:00.000Z',
          properties: {},
          disabledProperties: [],
          projects: [],
          environments: [],
        },
      },
    };
    expect(scopesFor(context).global).toEqual({ x: 'g' });
  });
});
