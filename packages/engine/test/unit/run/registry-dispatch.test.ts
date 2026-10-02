/** Select, step lookup, secret needs and the sender ask the registry, and a switch turns a protocol off. */
import { describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { defineProtocol } from '../../../src/protocol/module.js';
import type { RunGroup, SelectedBase } from '../../../src/protocol/module.js';
import { createProtocolRegistry } from '../../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE, createBuiltinRegistry, defaultRegistry } from '../../../src/protocols.js';
import { createApi, createRestRequest, entry } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { exchangeController } from '../../../src/run/exchange.js';
import { openExchange } from '../../../src/run/open.js';
import { checkRunScripts, createRunSender } from '../../../src/run/run.js';
import type { SentRequest } from '../../../src/run/run.js';
import { createRunScope } from '../../../src/run/scope.js';
import { testHost } from '../../helpers/send-host.js';
import { secretNeedsOf } from '../../../src/run/secret-needs.js';
import { findStepRequest, selectRequests } from '../../../src/run/select.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import type { ScriptSandbox } from '../../../src/script/sandbox/host.js';
import { runSequence } from '../../../src/sequence/run.js';
import type { SequenceDef } from '../../../src/sequence/model.js';
import { createWsApi, createWsRequest } from '../../../src/ws/model.js';
import { emptyStorage } from '../../helpers/empty-storage.js';

const project: Project = {
  ...createProject('Dispatch', { id: 'proj-dispatch' }),
  apis: [
    createApi('Api', {
      id: 'api-1',
      slug: 'api',
      order: 0,
      auth: { type: 'bearer', tokenRef: 'ref-token' },
      requests: [
        {
          ...createRestRequest('Ping', { id: 'req-ping', url: 'https://api.example.test/ping' }),
          headers: [entry('X-Tenant', '${secret:tenant}')],
          scripts: { api: 'wirebench', enabled: true, secrets: [], pre: { text: '' } },
        },
      ],
    }),
  ],
  grpcApis: [
    createGrpcApi('Greeter', {
      id: 'api-greeter',
      slug: 'greeter',
      order: 1,
      requests: [
        createGrpcRequest('Hello', { id: 'g-hello' }),
        createGrpcRequest('Chat', { id: 'g-chat', methodKind: 'bidi-streaming' }),
      ],
    }),
  ],
  wsApis: [
    createWsApi('Feed', { id: 'api-feed', order: 2, requests: [createWsRequest('Ticker', { id: 'ws-ticker' })] }),
  ],
};

const context: RunContext = {
  project,
  projectDir: '/nowhere',
  overrides: {},
  host: { getSecret: () => Promise.resolve(undefined) },
};

describe('the built-in registry', () => {
  it('holds the four protocols in order, and the scripts feature', () => {
    expect(BUILTIN_PROTOCOLS.map((module) => module.kind)).toEqual(['soap', 'rest', 'grpc', 'websocket']);
    expect(createBuiltinRegistry().features.descriptors.map((descriptor) => descriptor.id)).toEqual([
      'soap',
      'rest',
      'grpc',
      'websocket',
      'scripts',
    ]);
    expect(SCRIPTS_FEATURE).toEqual({ id: 'scripts', title: 'Scripts', default: true, stage: 'stable', requires: [] });
  });

  it('is created once as the default, with every feature on', () => {
    expect(defaultRegistry()).toBe(defaultRegistry());
    expect(defaultRegistry().modules).toHaveLength(4);
    expect(defaultRegistry().features.isEnabled('scripts')).toBe(true);
  });

  it('applies switches', () => {
    const registry = createBuiltinRegistry({ grpc: false, scripts: false });
    expect(registry.modules.map((module) => module.kind)).toEqual(['soap', 'rest', 'websocket']);
    expect(registry.features.isEnabled('scripts')).toBe(false);
  });
});

describe('a protocol switched off', () => {
  const withoutGrpc = createBuiltinRegistry({ grpc: false });
  const withoutRest = createBuiltinRegistry({ rest: false });

  it('has no request to select, so a selector naming one is unmatched', () => {
    expect(selectRequests(project, []).selected.map((item) => item.path)).toEqual([
      'Api/Ping',
      'Greeter/Chat',
      'Greeter/Hello',
      'Feed/Ticker',
    ]);
    expect(selectRequests(project, [], withoutGrpc).selected.map((item) => item.path)).toEqual([
      'Api/Ping',
      'Feed/Ticker',
    ]);
    expect(selectRequests(project, ['Feed'], createBuiltinRegistry({ websocket: false }))).toEqual({
      selected: [],
      unmatched: ['Feed'],
    });
    expect(selectRequests(project, ['Greeter'], withoutGrpc)).toEqual({ selected: [], unmatched: ['Greeter'] });
  });

  it('leaves a step naming its request missing, with or without a reason to give', () => {
    expect(findStepRequest(project, 'g-hello').kind).toBe('found');
    // A streaming gRPC call is a step like any other now that a run sends it.
    expect(findStepRequest(project, 'g-chat').kind).toBe('found');
    expect(findStepRequest(project, 'g-hello', withoutGrpc)).toEqual({ kind: 'missing' });
    expect(findStepRequest(project, 'g-chat', withoutGrpc)).toEqual({ kind: 'missing' });
    // A WebSocket request is a step like any other now that its module runs it.
    expect(findStepRequest(project, 'ws-ticker').kind).toBe('found');
    expect(findStepRequest(project, 'ws-ticker', createBuiltinRegistry({ websocket: false }))).toEqual({
      kind: 'missing',
    });
  });

  it('is what a sequence run looks its steps up in', async () => {
    const sequence: SequenceDef = {
      id: 'seq-1',
      name: 'One step',
      slug: 'one-step',
      order: 0,
      settings: { stopOnFailure: true },
      steps: [
        { id: 'step-1', requestId: 'g-hello', enabled: true, requestAssertions: true, assertions: [], transfers: [] },
      ],
    };
    const notSent = () => Promise.resolve({ error: { code: 'not-sent', message: 'not sent in this test' } });
    const on = await runSequence(sequence, project, notSent);
    expect(on.steps[0]?.error?.code).toBe('not-sent');
    const off = await runSequence(sequence, project, notSent, { registry: withoutGrpc });
    expect(off.steps[0]?.error?.code).toBe('sequence-step-missing-request');
  });

  it('keeps the generic secret needs of a request already selected, and drops its module’s', () => {
    const { selected } = selectRequests(project, ['Api/Ping']);
    expect(secretNeedsOf(selected, project).map((need) => need.ref)).toEqual(['secret:tenant', 'ref-token']);
    expect(secretNeedsOf(selected, project, {}, undefined, withoutRest).map((need) => need.ref)).toEqual([
      'secret:tenant',
    ]);
  });

  it('refuses a send of a request already selected with feature-disabled', async () => {
    const [ping] = selectRequests(project, ['Api/Ping']).selected;
    const send = createRunSender({ ...context, registry: withoutRest });
    await expect(ping && send(ping)).rejects.toMatchObject({
      code: 'feature-disabled',
      message: 'REST is switched off',
      details: { feature: 'rest' },
    });
  });

  it('reports the same refusal from the script check', async () => {
    const { selected } = selectRequests(project, ['Api/Ping']);
    const scripting = new RequestScripting({ sandbox: {} as ScriptSandbox });
    const errors = await checkRunScripts(selected, { ...context, scripting, registry: withoutRest });
    expect(errors.map((error) => error.code)).toEqual(['feature-disabled']);
    expect(await checkRunScripts(selected, { ...context, scripting })).toEqual([]);
  });
});

describe('the order of groups', () => {
  const item = (kind: string, name: string): SelectedBase => ({
    kind,
    path: `${name}/r`,
    group: name,
    request: { id: `${kind}-${name}`, name: 'r', slug: 'r' },
  });
  const group = (kind: string, order: number, name: string, explicitOnly = false): RunGroup => ({
    order,
    name,
    candidates: [{ item: item(kind, name), diskPath: `apis/${name}/requests/r` }],
    ...(explicitOnly ? { explicitOnly: true as const } : {}),
  });
  const module = (kind: string, groups: readonly RunGroup[]) =>
    defineProtocol({
      kind,
      feature: { id: kind, title: kind, default: true, stage: 'stable', requires: [] },
      storage: emptyStorage(kind),
      run: {
        groups: () => groups,
        whyNotRunnable: () => undefined,
        open: (_selected, _scope, _host, options) =>
          exchangeController(kind, options).handle(() => Promise.reject(new Error('not sent in this test'))),
        resolve: () => Promise.resolve({}),
        scriptTypes: () => Promise.resolve({ generated: '' }),
        secretNeeds: () => [],
      },
    });
  const registry = createProtocolRegistry([
    module('one', [group('one', 2, 'late'), group('one', 1, 'tie'), group('one', 0, 'hooks-b', true)]),
    module('two', [group('two', 1, 'tie'), group('two', 1, 'alpha'), group('two', 0, 'hooks-a', true)]),
  ]);
  const empty = createProject('Empty', { id: 'p0' });

  it('is by order, then name, then registration, with explicit-only groups left out of a run of everything', () => {
    expect(selectRequests(empty, [], registry).selected.map((s) => `${s.kind}:${s.group}`)).toEqual([
      'two:alpha',
      'one:tie',
      'two:tie',
      'one:late',
    ]);
  });

  it('puts explicit-only groups last when a selector reaches them', () => {
    const everything = ['alpha', 'tie', 'late', 'hooks-a', 'hooks-b'];
    expect(selectRequests(empty, everything, registry).selected.map((s) => `${s.kind}:${s.group}`)).toEqual([
      'two:alpha',
      'one:tie',
      'two:tie',
      'one:late',
      'two:hooks-a',
      'one:hooks-b',
    ]);
  });
});

describe('openExchange', () => {
  const sentStub: SentRequest = {
    subject: { protocol: 'fake', status: 200, durationMs: 1, bodyText: '', bodyKind: 'other' },
    raw: { rawRequest: new Uint8Array(), rawResponse: new Uint8Array() },
  };

  it('hands the item to its own module, and the module refuses another kind', async () => {
    interface FakeSelected extends SelectedBase {
      readonly kind: 'fake';
    }
    const opened: string[] = [];
    const fake = defineProtocol<FakeSelected>({
      kind: 'fake',
      feature: { id: 'fake', title: 'Fake', default: true, stage: 'stable', requires: [] },
      storage: emptyStorage('fake'),
      run: {
        groups: () => [],
        whyNotRunnable: () => undefined,
        open: (selected, _scope, _host, options) => {
          opened.push(selected.path);
          return exchangeController('fake', options).handle(() => Promise.resolve(sentStub));
        },
        resolve: () => Promise.resolve({}),
        scriptTypes: () => Promise.resolve({ generated: '' }),
        secretNeeds: () => [],
      },
    });
    const registry = createProtocolRegistry([fake]);
    const scope = createRunScope({
      project: createProject('P'),
      projectDir: '/x',
      overrides: {},
      host: testHost(),
      registry,
    });
    const item = { kind: 'fake', path: 'g/r', group: 'g', request: { id: 'r', name: 'r', slug: 'r' } };
    await openExchange(item as never, testHost(), { scope, interactive: false }).result;
    expect(opened).toEqual(['g/r']);
    expect(() => fake.run?.open({ ...item, kind: 'other' }, scope, testHost(), { scope, interactive: false })).toThrow(
      'The "fake" protocol was handed a "other" request',
    );
  });
});
