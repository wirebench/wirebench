/**
 * The script changes (#63): `update-request-scripts` edits one request's scripts on any protocol,
 * `enable-scripts` switches many on, and the other request edits and clones keep them.
 */
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_LIMITS,
  createApi,
  createFolder,
  createGrpcApi,
  createGrpcRequest,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  isWirebenchError,
} from '@wirebench/engine';
import type { Project, RequestScripts } from '@wirebench/engine';
import { findGrpcRequest } from '../src/main/project-grpc-mutations.js';
import { applyChange } from '../src/main/project-mutations.js';
import type { MutationDeps } from '../src/main/project-mutations.js';
import { findRestRequest } from '../src/main/project-rest-mutations.js';
import { findRequest, toRequestScriptsWire } from '../src/main/project-wire.js';

const deps: MutationDeps = {
  generate: () => Promise.resolve({ envelopeXml: '<Add/>', soapVersion: '1.1' }),
};

const OFF: RequestScripts = {
  pre: { text: 'pm.variables.set("a", "1");' },
  api: 'postman',
  enabled: false,
  secrets: [],
};

function build(): Project {
  const iface = createInterface('Calculator', {
    id: 'iface-1',
    definitionUrl: 'http://example.test/service.wsdl',
    operations: [
      {
        name: 'Add',
        bindingName: '{urn:c}CalculatorSoap',
        slug: 'Add',
        order: 0,
        requests: [createRequest('Add one', { id: 'soap-1', envelopeXml: '<Add/>', soapVersion: '1.1' })],
      },
    ],
  });
  const api = createApi('Shop', {
    id: 'api-1',
    baseUrl: 'http://shop.test',
    requests: [{ ...createRestRequest('Log in', { id: 'rest-1', order: 0 }), scripts: OFF }],
    folders: [
      createFolder('Carts', {
        id: 'f-1',
        order: 0,
        requests: [{ ...createRestRequest('Cart', { id: 'rest-2', order: 0 }), scripts: OFF }],
      }),
    ],
  });
  const grpc = createGrpcApi('Greeter', {
    id: 'g-1',
    target: 'localhost:50051',
    requests: [createGrpcRequest('Hello', { id: 'grpc-1', order: 0, service: 'a.Greeter', method: 'SayHello' })],
  });
  return { ...createProject('Demo', { id: 'p1' }), interfaces: [iface], apis: [api], grpcApis: [grpc] };
}

describe('update-request-scripts', () => {
  it('gives a SOAP request scripts on the typed API, switched on', async () => {
    const { project } = await applyChange(
      build(),
      { kind: 'update-request-scripts', requestId: 'soap-1', scripts: { post: 'test("ok", () => {});' } },
      deps,
    );
    expect(findRequest(project, 'soap-1')?.request.scripts).toEqual({
      post: { text: 'test("ok", () => {});' },
      api: 'wirebench',
      enabled: true,
      secrets: [],
    });
  });

  it('edits only the fields present, and a null script or timeout removes it', async () => {
    let { project } = await applyChange(
      build(),
      {
        kind: 'update-request-scripts',
        requestId: 'grpc-1',
        scripts: { pre: 'log(1);', post: 'log(2);', secrets: ['signing_key', 'signing_key'], timeoutMs: 500 },
      },
      deps,
    );
    ({ project } = await applyChange(
      project,
      { kind: 'update-request-scripts', requestId: 'grpc-1', scripts: { pre: null, timeoutMs: null } },
      deps,
    ));
    expect(findGrpcRequest(project, 'grpc-1')?.scripts).toEqual({
      post: { text: 'log(2);' },
      api: 'wirebench',
      enabled: true,
      secrets: ['signing_key'],
    });
  });

  it('keeps an imported script on its own API and switched off until switched on', async () => {
    const { project } = await applyChange(
      build(),
      { kind: 'update-request-scripts', requestId: 'rest-1', scripts: { post: 'pm.test("t", () => {});' } },
      deps,
    );
    const scripts = findRestRequest(project, 'rest-1')?.scripts;
    expect(scripts?.api).toBe('postman');
    expect(scripts?.enabled).toBe(false);
    expect(scripts?.pre?.text).toBe(OFF.pre?.text);
  });

  it('removes the scripts with null, and when nothing is left', async () => {
    const removed = await applyChange(
      build(),
      { kind: 'update-request-scripts', requestId: 'rest-1', scripts: null },
      deps,
    );
    expect(findRestRequest(removed.project, 'rest-1')).not.toHaveProperty('scripts');
    const emptied = await applyChange(
      build(),
      { kind: 'update-request-scripts', requestId: 'rest-1', scripts: { pre: null } },
      deps,
    );
    expect(findRestRequest(emptied.project, 'rest-1')).not.toHaveProperty('scripts');
  });

  it('marks a script over the size limit, as a loaded one is, so the request refuses to send', async () => {
    const text = 'x'.repeat(SCRIPT_LIMITS.fileBytes + 1);
    const { project } = await applyChange(
      build(),
      { kind: 'update-request-scripts', requestId: 'soap-1', scripts: { pre: text } },
      deps,
    );
    expect(findRequest(project, 'soap-1')?.request.scripts?.pre).toEqual({ text, problem: 'script-too-large' });
    expect(toRequestScriptsWire(findRequest(project, 'soap-1')?.request.scripts)?.problems).toEqual([
      { phase: 'pre', code: 'script-too-large' },
    ]);
  });

  it('refuses an id no request has', async () => {
    await expect(
      applyChange(build(), { kind: 'update-request-scripts', requestId: 'nope', scripts: null }, deps),
    ).rejects.toSatisfy((error: unknown) => isWirebenchError(error) && error.code === 'unknown-entity');
  });
});

describe('enable-scripts', () => {
  it('switches on every listed request that has scripts, and passes over the rest', async () => {
    const before = build();
    const { project } = await applyChange(
      before,
      { kind: 'enable-scripts', requestIds: ['rest-1', 'rest-2', 'grpc-1', 'missing'] },
      deps,
    );
    expect(findRestRequest(project, 'rest-1')?.scripts?.enabled).toBe(true);
    expect(findRestRequest(project, 'rest-2')?.scripts?.enabled).toBe(true);
    expect(findGrpcRequest(project, 'grpc-1')).not.toHaveProperty('scripts');
    // Untouched parts of the tree stay the same objects.
    expect(project.interfaces).toBe(before.interfaces);
    expect(project.grpcApis).toBe(before.grpcApis);
  });
});

describe('other edits keep scripts', () => {
  it('a REST edit, a SOAP edit and a SOAP auth edit', async () => {
    let { project } = await applyChange(
      build(),
      { kind: 'update-request-scripts', requestId: 'soap-1', scripts: { pre: 'log(1);' } },
      deps,
    );
    ({ project } = await applyChange(
      project,
      { kind: 'update-request', requestId: 'soap-1', patch: { name: 'Add two' } },
      deps,
    ));
    ({ project } = await applyChange(
      project,
      { kind: 'update-request-auth', requestId: 'soap-1', auth: { type: 'basic', username: 'u' } },
      deps,
    ));
    ({ project } = await applyChange(
      project,
      { kind: 'update-rest-request', requestId: 'rest-1', patch: { url: '/x' } },
      deps,
    ));
    expect(findRequest(project, 'soap-1')?.request.scripts?.pre?.text).toBe('log(1);');
    expect(findRestRequest(project, 'rest-1')?.scripts).toEqual(OFF);
  });

  it('a REST and a gRPC clone copy them', async () => {
    let { project } = await applyChange(
      build(),
      { kind: 'update-request-scripts', requestId: 'grpc-1', scripts: { post: 'log(1);' } },
      deps,
    );
    const rest = await applyChange(project, { kind: 'clone-rest-request', requestId: 'rest-1' }, deps);
    expect(findRestRequest(rest.project, rest.createdId!)?.scripts).toEqual(OFF);
    ({ project } = await applyChange(project, { kind: 'clone-grpc-request', requestId: 'grpc-1' }, deps));
    const copies = project.grpcApis[0]!.requests.filter((request) => request.id !== 'grpc-1');
    expect(copies[0]?.scripts?.post?.text).toBe('log(1);');
  });
});
