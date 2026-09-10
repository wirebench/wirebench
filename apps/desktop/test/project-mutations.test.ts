import { describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest, isWirebenchError } from '@wirebench/engine';
import type { Interface, Project } from '@wirebench/engine';
import { addRequest, applyChange, projectNameFromDir } from '../src/main/project-mutations.js';
import type { MutationDeps } from '../src/main/project-mutations.js';
import { findRequest } from '../src/main/project-wire.js';

const BINDING = '{http://tempuri.org/}CalculatorSoap';

const deps: MutationDeps = {
  generate: (_i, _b, operationName) =>
    Promise.resolve({ envelopeXml: `<${operationName}/>`, soapVersion: '1.1', soapAction: `urn:${operationName}` }),
};

function build(): Project {
  const iface: Interface = createInterface('Calculator', {
    id: 'iface-1',
    definitionUrl: 'http://example.test/service.wsdl',
    endpoints: [
      { id: 'ep-1', name: 'Primary', url: 'http://a.test/soap', authMode: 'complement' },
      { id: 'ep-2', name: 'Staging', url: 'http://b.test/soap', authMode: 'complement' },
    ],
    operations: [
      {
        name: 'Add',
        bindingName: BINDING,
        slug: 'Add',
        order: 0,
        requests: [
          createRequest('Request 1', { id: 'req-1', envelopeXml: '<Add/>', soapVersion: '1.1', endpointId: 'ep-1' }),
        ],
      },
    ],
  });
  return { ...createProject('Demo', { id: 'proj-1' }), interfaces: [iface] };
}

async function expectNotFound(run: Promise<unknown>): Promise<void> {
  await expect(run).rejects.toSatisfy((error: unknown) => isWirebenchError(error) && error.code === 'not-found');
}

describe('applyChange', () => {
  it('renames the project without touching anything else', async () => {
    const { project } = await applyChange(build(), { kind: 'rename-project', name: 'Renamed' }, deps);
    expect(project.name).toBe('Renamed');
    expect(project.interfaces).toHaveLength(1);
  });

  it('add-request generates an envelope and names it Request N', async () => {
    const result = await applyChange(
      build(),
      { kind: 'add-request', interfaceId: 'iface-1', bindingName: BINDING, operationName: 'Add' },
      deps,
    );
    const created = findRequest(result.project, result.createdRequestId!);
    expect(created?.request.name).toBe('Request 2');
    expect(created?.request.slug).toBe('Request 2');
    expect(created?.request.envelopeXml).toBe('<Add/>');
    expect(created?.request.order).toBe(1);
    // The interface default endpoint is pre-selected, so a new request is sendable at once.
    expect(created?.request.endpointId).toBe('ep-1');
  });

  it('add-request creates the operation when the interface does not declare it yet', async () => {
    const result = await applyChange(
      build(),
      { kind: 'add-request', interfaceId: 'iface-1', bindingName: BINDING, operationName: 'Subtract' },
      deps,
    );
    const created = findRequest(result.project, result.createdRequestId!);
    expect(created?.operation.name).toBe('Subtract');
    expect(created?.request.name).toBe('Request 1');
  });

  it('clone-request copies the envelope under a "(copy)" name and a unique slug', async () => {
    const result = await applyChange(build(), { kind: 'clone-request', requestId: 'req-1' }, deps);
    const clone = findRequest(result.project, result.createdRequestId!);
    expect(clone?.request.name).toBe('Request 1 (copy)');
    expect(clone?.request.envelopeXml).toBe('<Add/>');
    expect(clone?.request.id).not.toBe('req-1');
  });

  it('remove-request drops it and renumbers the survivors', async () => {
    const two = await applyChange(build(), { kind: 'clone-request', requestId: 'req-1' }, deps);
    const result = await applyChange(two.project, { kind: 'remove-request', requestId: 'req-1' }, deps);
    const operation = result.project.interfaces[0]!.operations[0]!;
    expect(operation.requests.map((r) => r.name)).toEqual(['Request 1 (copy)']);
    expect(operation.requests[0]?.order).toBe(0);
  });

  it('update-request renames, re-slugs, and clears an optional field with null', async () => {
    const renamed = await applyChange(
      build(),
      { kind: 'update-request', requestId: 'req-1', patch: { name: 'Smoke test', envelopeXml: '<edited/>' } },
      deps,
    );
    const request = findRequest(renamed.project, 'req-1')!.request;
    expect(request.name).toBe('Smoke test');
    expect(request.slug).toBe('Smoke test');
    expect(request.envelopeXml).toBe('<edited/>');
    expect(request.endpointId).toBe('ep-1');

    const cleared = await applyChange(
      renamed.project,
      { kind: 'update-request', requestId: 'req-1', patch: { endpointId: null, endpointUrl: 'http://custom/soap' } },
      deps,
    );
    const after = findRequest(cleared.project, 'req-1')!.request;
    expect(after.endpointId).toBeUndefined();
    expect(after.endpointUrl).toBe('http://custom/soap');
  });

  it('endpoint changes keep a sane default', async () => {
    const added = await applyChange(
      build(),
      { kind: 'add-endpoint', interfaceId: 'iface-1', name: 'Local', url: 'http://localhost/soap' },
      deps,
    );
    expect(added.project.interfaces[0]?.endpoints).toHaveLength(3);
    expect(added.project.interfaces[0]?.defaultEndpointId).toBe('ep-1');

    const renamedEndpoint = await applyChange(
      added.project,
      { kind: 'update-endpoint', interfaceId: 'iface-1', endpointId: 'ep-2', patch: { url: 'http://b2.test/soap' } },
      deps,
    );
    expect(renamedEndpoint.project.interfaces[0]?.endpoints[1]).toMatchObject({
      name: 'Staging',
      url: 'http://b2.test/soap',
    });

    const switched = await applyChange(
      renamedEndpoint.project,
      { kind: 'set-default-endpoint', interfaceId: 'iface-1', endpointId: 'ep-2' },
      deps,
    );
    expect(switched.project.interfaces[0]?.defaultEndpointId).toBe('ep-2');

    // Removing the default promotes the first survivor rather than leaving a dangling id.
    const removed = await applyChange(
      switched.project,
      { kind: 'remove-endpoint', interfaceId: 'iface-1', endpointId: 'ep-2' },
      deps,
    );
    expect(removed.project.interfaces[0]?.defaultEndpointId).toBe('ep-1');
  });

  it('project properties can be set and removed', async () => {
    const set = await applyChange(build(), { kind: 'set-project-property', name: 'host', value: 'a.test' }, deps);
    expect(set.project.properties).toEqual({ host: 'a.test' });
    const removed = await applyChange(set.project, { kind: 'remove-project-property', name: 'host' }, deps);
    expect(removed.project.properties).toEqual({});
  });

  it('remove-interface drops the interface and renumbers the rest', async () => {
    const result = await applyChange(build(), { kind: 'remove-interface', interfaceId: 'iface-1' }, deps);
    expect(result.project.interfaces).toEqual([]);
  });

  it('rejects unknown ids rather than silently doing nothing', async () => {
    await expectNotFound(applyChange(build(), { kind: 'remove-interface', interfaceId: 'nope' }, deps));
    await expectNotFound(applyChange(build(), { kind: 'clone-request', requestId: 'nope' }, deps));
    await expectNotFound(applyChange(build(), { kind: 'remove-request', requestId: 'nope' }, deps));
    await expectNotFound(applyChange(build(), { kind: 'update-request', requestId: 'nope', patch: {} }, deps));
    await expectNotFound(
      applyChange(build(), { kind: 'set-default-endpoint', interfaceId: 'iface-1', endpointId: 'nope' }, deps),
    );
  });

  it('never mutates the project it is given', async () => {
    const project = build();
    const before = JSON.stringify(project);
    await applyChange(project, { kind: 'rename-project', name: 'Other' }, deps);
    expect(JSON.stringify(project)).toBe(before);
  });

  it('addRequest can be told the name to use (the per-operation "Request 1" of an import)', () => {
    const result = addRequest(build(), {
      interfaceId: 'iface-1',
      bindingName: BINDING,
      operationName: 'Divide',
      name: 'Request 1',
      generated: { envelopeXml: '<Divide/>', soapVersion: '1.2' },
    });
    const created = findRequest(result.project, result.createdRequestId!);
    expect(created?.request.name).toBe('Request 1');
    expect(created?.request.soapVersion).toBe('1.2');
  });

  it('projectNameFromDir uses the folder name', () => {
    expect(projectNameFromDir('/tmp/some/Payments API/')).toBe('Payments API');
  });
});
