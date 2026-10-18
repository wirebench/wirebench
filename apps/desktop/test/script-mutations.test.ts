/**
 * The script changes (#63): `update-request-scripts` edits one request's scripts on any protocol,
 * `enable-scripts` switches many on, and the other request edits and clones keep them.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createApi,
  createFolder,
  createGrpcApi,
  createGrpcRequest,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  grpcApisOf,
  isWirebenchError,
  loadProject,
  saveProject,
  restApisOf,
  SCRIPT_LIMITS,
  soapInterfacesOf,
  withRestApis,
} from '@wirebench/engine';
import type { Project, RequestScripts } from '@wirebench/engine';
import { findGrpcRequest } from '../src/main/kinds/grpc/mutations.js';
import { applyChange } from '../src/main/project-mutations.js';
import type { MutationDeps } from '../src/main/project-mutations.js';
import { findRestRequest } from '../src/main/kinds/rest/mutations.js';
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
  return { ...createProject('Demo', { id: 'p1' }), containers: { soap: [iface], rest: [api], grpc: [grpc] } };
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

  it('keeps an API’s post-response order through the wire and across later edits', async () => {
    let { project } = await applyChange(
      build(),
      {
        kind: 'update-request-scripts',
        requestId: 'api-1',
        scripts: { post: 'log(1);', postResponseOrder: 'inner-first' },
      },
      deps,
    );
    expect(restApisOf(project)[0]?.scripts?.postResponseOrder).toBe('inner-first');
    expect(toRequestScriptsWire(restApisOf(project)[0]?.scripts)?.postResponseOrder).toBe('inner-first');

    ({ project } = await applyChange(
      project,
      { kind: 'update-request-scripts', requestId: 'api-1', scripts: { post: 'log(2);' } },
      deps,
    ));
    expect(restApisOf(project)[0]?.scripts?.postResponseOrder).toBe('inner-first');

    ({ project } = await applyChange(
      project,
      { kind: 'update-request-scripts', requestId: 'api-1', scripts: { postResponseOrder: 'outer-first' } },
      deps,
    ));
    expect(toRequestScriptsWire(restApisOf(project)[0]?.scripts)?.postResponseOrder).toBe('outer-first');
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
    expect(soapInterfacesOf(project)).toBe(soapInterfacesOf(before));
    expect(grpcApisOf(project)).toBe(grpcApisOf(before));
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
    const copies = grpcApisOf(project)[0]!.requests.filter((request) => request.id !== 'grpc-1');
    expect(copies[0]?.scripts?.post?.text).toBe('log(1);');
  });
});

describe('an API’s post-response order without scripts', () => {
  it('keeps an order-only scripts object across a save and load, and drops a lone outer-first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-order-'));
    try {
      const { project } = await applyChange(
        build(),
        { kind: 'update-request-scripts', requestId: 'api-1', scripts: { postResponseOrder: 'inner-first' } },
        deps,
      );
      expect(restApisOf(project)[0]?.scripts).toEqual({
        api: 'wirebench',
        enabled: true,
        secrets: [],
        postResponseOrder: 'inner-first',
      });
      await saveProject(project, dir);
      const loaded = await loadProject(dir);
      expect(restApisOf(loaded.project)[0]?.scripts?.postResponseOrder).toBe('inner-first');

      const back = await applyChange(
        project,
        { kind: 'update-request-scripts', requestId: 'api-1', scripts: { postResponseOrder: 'outer-first' } },
        deps,
      );
      // Back to the default with nothing else to keep: the scripts object goes.
      expect(restApisOf(back.project)[0]).not.toHaveProperty('scripts');
      const fresh = await applyChange(
        build(),
        { kind: 'update-request-scripts', requestId: 'api-1', scripts: { postResponseOrder: 'outer-first' } },
        deps,
      );
      expect(restApisOf(fresh.project)[0]).not.toHaveProperty('scripts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('level scripts (#334)', () => {
  it('update-request-scripts edits an API’s, a folder’s, an interface’s and a gRPC API’s scripts by id', async () => {
    let project = build();
    for (const id of ['api-1', 'f-1', 'iface-1', 'g-1']) {
      ({ project } = await applyChange(
        project,
        { kind: 'update-request-scripts', requestId: id, scripts: { pre: `log("${id}");` } },
        deps,
      ));
    }
    const on = (id: string) => ({ pre: { text: `log("${id}");` }, api: 'wirebench', enabled: true, secrets: [] });
    const api = restApisOf(project)[0]!;
    expect(api.scripts).toEqual(on('api-1'));
    expect(api.folders[0]?.scripts).toEqual(on('f-1'));
    expect(soapInterfacesOf(project)[0]?.scripts).toEqual(on('iface-1'));
    expect(grpcApisOf(project)[0]?.scripts).toEqual(on('g-1'));

    ({ project } = await applyChange(
      project,
      { kind: 'update-request-scripts', requestId: 'f-1', scripts: null },
      deps,
    ));
    expect(restApisOf(project)[0]?.folders[0]).not.toHaveProperty('scripts');
  });

  it('enable-scripts switches on a listed API’s and folder’s scripts', async () => {
    const before = build();
    const api = restApisOf(before)[0]!;
    const levelled = withRestApis(before, [{ ...api, scripts: OFF, folders: [{ ...api.folders[0]!, scripts: OFF }] }]);
    const { project } = await applyChange(levelled, { kind: 'enable-scripts', requestIds: ['api-1', 'f-1'] }, deps);
    const after = restApisOf(project)[0]!;
    expect(after.scripts?.enabled).toBe(true);
    expect(after.folders[0]?.scripts?.enabled).toBe(true);
    // The requests were not listed, so theirs stay off.
    expect(after.requests[0]?.scripts?.enabled).toBe(false);
  });
});
