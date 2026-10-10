// @vitest-environment node
/**
 * Main's script host (#63): the editor's diagnostics and completion against a request's own
 * declarations, what a send looks up, and the session values — kept per project, masked when
 * listed, bounded, and cleared.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApi,
  createMock,
  createMockOperation,
  createMockResponse,
  createProject,
  createRestRequest,
} from '@wirebench/engine';
import type { Project, RequestScripts } from '@wirebench/engine';
import { SESSION_VALUE_LIMIT, ScriptHost } from '../src/main/script-host.js';
import { recordSecretValue } from '../src/main/redact.js';

const SCRIPTS: RequestScripts = {
  post: { text: 'log(response.status);' },
  api: 'wirebench',
  enabled: true,
  secrets: [],
};

function model(scripts: RequestScripts | undefined): Project {
  const request = createRestRequest('Echo', { id: 'r1', url: '/echo' });
  const api = createApi('Shop', {
    id: 'api-1',
    baseUrl: 'http://shop.test',
    requests: [scripts === undefined ? request : { ...request, scripts }],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

let host: ScriptHost | undefined;
const changed: string[] = [];

function hostFor(project: Project): ScriptHost {
  host = new ScriptHost({
    modelOf: () => project,
    openApiDocumentFor: () => Promise.reject(new Error('no definition')),
    grpcProtoSetFor: () => Promise.reject(new Error('no definition')),
    soapDefinitionFor: () => undefined,
    onValuesChanged: (projectId) => changed.push(projectId),
  });
  return host;
}

afterEach(async () => {
  await host?.dispose();
  changed.length = 0;
});

describe('the editor', () => {
  it('reports a type error against the phase it is in', { timeout: 60_000 }, async () => {
    const scripts = hostFor(model(SCRIPTS));
    const post = await scripts.diagnostics({ requestId: 'r1', phase: 'post' }, 'log(response.statuss);');
    expect(post.map((d) => [d.line, d.code])).toEqual([[1, 2551]]);
    // A pre-request script has no response.
    const pre = await scripts.diagnostics({ requestId: 'r1', phase: 'pre' }, 'log(response.status);');
    expect(pre.map((d) => d.severity)).toEqual(['error']);
    await scripts.closeModel({ requestId: 'r1', phase: 'post' });
  });

  it('completes the script API', { timeout: 60_000 }, async () => {
    const items = await hostFor(model(SCRIPTS)).completions({ requestId: 'r1', phase: 'pre' }, 'va', 1, 3);
    expect(items.map((item) => item.name)).toContain('vars');
  });
});

describe('the dispatch script editor (#352)', () => {
  const DISPATCH = { mockId: 'm1', operationId: 'o1' };

  function withMock(): Project {
    const operation = createMockOperation('Get pet', 'get /pets', {
      id: 'o1',
      dispatch: 'script',
      responses: [createMockResponse('Found'), createMockResponse('Missing')],
    });
    const mock = createMock('Pets', { containerId: 'api-1' }, { id: 'm1', operations: [operation] });
    return { ...model(undefined), mocks: [mock] };
  }

  it('checks respond against the operation response names', { timeout: 60_000 }, async () => {
    const scripts = hostFor(withMock());
    expect(await scripts.diagnostics(DISPATCH, "respond(request.method === 'GET' ? 'Found' : 'Missing');")).toEqual([]);
    const wrong = await scripts.diagnostics(DISPATCH, "respond('Gone');");
    expect(wrong.map((d) => [d.line, d.code])).toEqual([[1, 2345]]);
    // A dispatch script has no request-script globals.
    expect((await scripts.diagnostics(DISPATCH, "vars.set('a', '1');")).map((d) => d.code)).toEqual([2304]);
    await scripts.closeModel(DISPATCH);
  });

  it('completes the dispatch API', { timeout: 60_000 }, async () => {
    const items = await hostFor(withMock()).completions(DISPATCH, 'res', 1, 4);
    expect(items.map((item) => item.name)).toEqual(expect.arrayContaining(['respond', 'responses']));
  });
});

describe('lookup', () => {
  it('tells a send whether its request has scripts, and whether they run', async () => {
    expect(await hostFor(model(undefined)).lookup('r1')).toEqual({ kind: 'none' });
    expect(await hostFor(model({ ...SCRIPTS, enabled: false })).lookup('r1')).toEqual({ kind: 'off' });
    const on = await hostFor(model(SCRIPTS)).lookup('r1');
    expect(on.kind === 'on' ? [on.request.protocol, on.request.path, on.request.slug] : on).toEqual([
      'rest',
      'Shop / Echo',
      'Echo',
    ]);
  });
});

describe('session values', () => {
  it('keeps them per project, lists a secret one without its value, and clears them', () => {
    const scripts = hostFor(model(undefined));
    recordSecretValue('known-credential-41c7');
    scripts.keepValues('p1', [
      { name: 'token', value: 'tok-1', secret: true },
      { name: 'echo', value: 'has known-credential-41c7 in it', secret: false },
      { name: 'plain', value: 'visible', secret: false },
    ]);
    expect(scripts.sessionValues('p2')).toEqual({});
    expect(scripts.listValues('p1')).toEqual([
      { name: 'token', secret: true },
      { name: 'echo', secret: true },
      { name: 'plain', value: 'visible', secret: false },
    ]);
    expect(changed).toEqual(['p1']);
    expect(scripts.clearValues('p1')).toBe(3);
    expect(scripts.sessionValues('p1')).toEqual({});
    expect(scripts.clearValues('p1')).toBe(0);
    expect(changed).toEqual(['p1', 'p1']);
  });

  it('keeps the newest values when there are too many', () => {
    const scripts = hostFor(model(undefined));
    scripts.keepValues('p1', [{ name: 'first', value: '1', secret: false }]);
    scripts.keepValues(
      'p1',
      Array.from({ length: SESSION_VALUE_LIMIT }, (_, i) => ({ name: `v${String(i)}`, value: 'x', secret: false })),
    );
    const values = scripts.sessionValues('p1');
    expect(Object.keys(values)).toHaveLength(SESSION_VALUE_LIMIT);
    expect(values).not.toHaveProperty('first');
  });
});
