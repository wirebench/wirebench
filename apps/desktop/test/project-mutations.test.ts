import { describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest, isWirebenchError } from '@wirebench/engine';
import type { Interface, Project } from '@wirebench/engine';
import { addRequest, applyChange, contentTypeForPath, projectNameFromDir } from '../src/main/project-mutations.js';
import type { AddAttachmentFile, MutationDeps } from '../src/main/project-mutations.js';
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

  it('update-request-auth carries a committed passwordEnv through, though the desktop never edits it', async () => {
    const result = await applyChange(
      build(),
      {
        kind: 'update-request-auth',
        requestId: 'req-1',
        auth: { type: 'basic', username: 'svc', passwordRef: 'sec_1', passwordEnv: 'BILLING_PASSWORD' },
      },
      deps,
    );
    const found = findRequest(result.project, 'req-1');
    expect(found?.request.auth).toMatchObject({ passwordEnv: 'BILLING_PASSWORD' });
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

  it('a project property can be disabled and re-enabled without losing its value', async () => {
    const set = await applyChange(build(), { kind: 'set-project-property', name: 'host', value: 'a.test' }, deps);
    expect(set.project.disabledProperties).toEqual([]);

    const disabled = await applyChange(
      set.project,
      { kind: 'set-project-property-enabled', name: 'host', enabled: false },
      deps,
    );
    expect(disabled.project.disabledProperties).toEqual(['host']);
    expect(disabled.project.properties).toEqual({ host: 'a.test' });

    const reEnabled = await applyChange(
      disabled.project,
      { kind: 'set-project-property-enabled', name: 'host', enabled: true },
      deps,
    );
    expect(reEnabled.project.disabledProperties).toEqual([]);
    expect(reEnabled.project.properties).toEqual({ host: 'a.test' });
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

describe('applyChange: environments', () => {
  async function withEnvironments(): Promise<Project> {
    const first = await applyChange(build(), { kind: 'add-environment', name: 'Dev' }, deps);
    const second = await applyChange(first.project, { kind: 'add-environment', name: 'Prod' }, deps);
    return second.project;
  }

  it('add-environment appends an empty, uniquely-slugged environment and reports its id', async () => {
    const result = await applyChange(build(), { kind: 'add-environment', name: 'Dev' }, deps);
    const [environment] = result.project.environments;

    expect(result.createdEnvironmentId).toBe(environment?.id);
    expect(environment).toMatchObject({
      name: 'Dev',
      slug: 'Dev',
      order: 0,
      endpoints: {},
      properties: {},
      disabledProperties: [],
    });

    const twice = await applyChange(result.project, { kind: 'add-environment', name: 'Dev' }, deps);
    expect(twice.project.environments.map((env) => env.slug)).toEqual(['Dev', 'Dev-2']);
    expect(twice.project.environments.map((env) => env.order)).toEqual([0, 1]);
  });

  it('update-environment renames (re-slugging) and replaces the endpoint/property maps whole', async () => {
    const project = await withEnvironments();
    const target = project.environments[0]!;

    const renamed = await applyChange(
      project,
      {
        kind: 'update-environment',
        environmentId: target.id,
        patch: { name: 'Staging', endpoints: { Calculator: 'http://staging.test/soap' }, properties: { who: 'me' } },
      },
      deps,
    );
    expect(renamed.project.environments[0]).toMatchObject({
      name: 'Staging',
      slug: 'Staging',
      endpoints: { Calculator: 'http://staging.test/soap' },
      properties: { who: 'me' },
    });

    // A patch without a map leaves it alone; a patch with one replaces it (keys can disappear).
    const cleared = await applyChange(
      renamed.project,
      { kind: 'update-environment', environmentId: target.id, patch: { properties: {} } },
      deps,
    );
    expect(cleared.project.environments[0]).toMatchObject({
      endpoints: { Calculator: 'http://staging.test/soap' },
      properties: {},
    });
  });

  it('set-active-environment switches and clears the active environment', async () => {
    const project = await withEnvironments();
    const active = await applyChange(
      project,
      { kind: 'set-active-environment', environmentId: project.environments[1]!.id },
      deps,
    );
    expect(active.project.activeEnvironmentId).toBe(project.environments[1]!.id);

    const cleared = await applyChange(active.project, { kind: 'set-active-environment', environmentId: null }, deps);
    expect('activeEnvironmentId' in cleared.project).toBe(false);
  });

  it('remove-environment drops it and deactivates it when it was active', async () => {
    const project = await withEnvironments();
    const active = await applyChange(
      project,
      { kind: 'set-active-environment', environmentId: project.environments[0]!.id },
      deps,
    );

    const removed = await applyChange(
      active.project,
      { kind: 'remove-environment', environmentId: project.environments[0]!.id },
      deps,
    );
    expect(removed.project.environments.map((env) => env.name)).toEqual(['Prod']);
    expect('activeEnvironmentId' in removed.project).toBe(false);

    // Removing a non-active environment leaves the active one alone.
    const stillActive = await applyChange(
      active.project,
      { kind: 'remove-environment', environmentId: project.environments[1]!.id },
      deps,
    );
    expect(stillActive.project.activeEnvironmentId).toBe(project.environments[0]!.id);
  });

  it('rejects unknown environment ids', async () => {
    const project = await withEnvironments();
    await expectNotFound(applyChange(project, { kind: 'remove-environment', environmentId: 'nope' }, deps));
    await expectNotFound(applyChange(project, { kind: 'set-active-environment', environmentId: 'nope' }, deps));
    await expectNotFound(
      applyChange(project, { kind: 'update-environment', environmentId: 'nope', patch: { name: 'x' } }, deps),
    );
  });
});

describe('applyChange attachments', () => {
  /** Deps whose `addAttachmentFile` records what it was asked for and answers deterministically. */
  function attachmentDeps(): MutationDeps & { calls: Parameters<AddAttachmentFile>[0][] } {
    const calls: Parameters<AddAttachmentFile>[0][] = [];
    return {
      ...deps,
      calls,
      addAttachmentFile: (input) => {
        calls.push(input);
        return Promise.resolve(
          input.copyToCache
            ? { size: 12, source: { kind: 'cache', sha256: 'a'.repeat(64) } }
            : { size: 12, source: { kind: 'path', path: input.path } },
        );
      },
    };
  }

  it('add-attachment copies into the cache and records a cache source', async () => {
    const mutationDeps = attachmentDeps();
    const result = await applyChange(
      build(),
      { kind: 'add-attachment', requestId: 'req-1', path: '/files/logo.PNG', copyToCache: true },
      mutationDeps,
    );
    const attachment = findRequest(result.project, 'req-1')!.request.attachments[0]!;
    expect(result.createdAttachmentId).toBe(attachment.id);
    expect(attachment).toMatchObject({
      name: 'logo.PNG',
      contentType: 'image/png',
      size: 12,
      type: 'UNKNOWN',
      cached: true,
      source: { kind: 'cache', sha256: 'a'.repeat(64) },
    });
    expect(attachment.contentId).toBe(`${attachment.id}@wirebench`);
    // The sniffed content type is passed down, so the cache index records it too.
    expect(mutationDeps.calls[0]).toEqual({ path: '/files/logo.PNG', copyToCache: true, contentType: 'image/png' });
  });

  it('add-attachment without copyToCache references the file in place and honours an explicit type', async () => {
    const result = await applyChange(
      build(),
      {
        kind: 'add-attachment',
        requestId: 'req-1',
        path: '/files/payload.bin',
        copyToCache: false,
        contentType: 'application/vnd.custom',
      },
      attachmentDeps(),
    );
    const attachment = findRequest(result.project, 'req-1')!.request.attachments[0]!;
    expect(attachment).toMatchObject({
      name: 'payload.bin',
      contentType: 'application/vnd.custom',
      cached: false,
      source: { kind: 'path', path: '/files/payload.bin' },
    });
  });

  it('add-attachment falls back to octet-stream for an unknown extension', async () => {
    const result = await applyChange(
      build(),
      { kind: 'add-attachment', requestId: 'req-1', path: '/files/thing.qqq', copyToCache: false },
      attachmentDeps(),
    );
    expect(findRequest(result.project, 'req-1')!.request.attachments[0]?.contentType).toBe('application/octet-stream');
  });

  it('update-attachment patches the named fields and clears part with null', async () => {
    const added = await applyChange(
      build(),
      { kind: 'add-attachment', requestId: 'req-1', path: '/files/a.xml', copyToCache: false },
      attachmentDeps(),
    );
    const id = added.createdAttachmentId!;
    const patched = await applyChange(
      added.project,
      {
        kind: 'update-attachment',
        requestId: 'req-1',
        attachmentId: id,
        patch: {
          name: 'renamed.xml',
          contentType: 'text/xml',
          contentId: 'part1@wirebench',
          type: 'MIME',
          part: 'file',
        },
      },
      deps,
    );
    expect(findRequest(patched.project, 'req-1')!.request.attachments[0]).toMatchObject({
      name: 'renamed.xml',
      contentType: 'text/xml',
      contentId: 'part1@wirebench',
      type: 'MIME',
      part: 'file',
    });

    const cleared = await applyChange(
      patched.project,
      { kind: 'update-attachment', requestId: 'req-1', attachmentId: id, patch: { part: null } },
      deps,
    );
    expect(findRequest(cleared.project, 'req-1')!.request.attachments[0]?.part).toBeUndefined();
  });

  it('remove-attachment drops just that attachment', async () => {
    const one = await applyChange(
      build(),
      { kind: 'add-attachment', requestId: 'req-1', path: '/files/a.pdf', copyToCache: false },
      attachmentDeps(),
    );
    const two = await applyChange(
      one.project,
      { kind: 'add-attachment', requestId: 'req-1', path: '/files/b.zip', copyToCache: false },
      attachmentDeps(),
    );
    const removed = await applyChange(
      two.project,
      { kind: 'remove-attachment', requestId: 'req-1', attachmentId: one.createdAttachmentId! },
      deps,
    );
    expect(findRequest(removed.project, 'req-1')!.request.attachments.map((a) => a.name)).toEqual(['b.zip']);
  });

  it('rejects an unknown attachment id', async () => {
    await expectNotFound(
      applyChange(build(), { kind: 'update-attachment', requestId: 'req-1', attachmentId: 'nope', patch: {} }, deps),
    );
    await expectNotFound(
      applyChange(build(), { kind: 'remove-attachment', requestId: 'req-1', attachmentId: 'nope' }, deps),
    );
  });

  it('add-attachment needs an addAttachmentFile dep', async () => {
    await expect(
      applyChange(build(), { kind: 'add-attachment', requestId: 'req-1', path: '/a.png', copyToCache: true }, deps),
    ).rejects.toThrow(/attachment/i);
  });
});

describe('contentTypeForPath', () => {
  it.each([
    ['a.png', 'image/png'],
    ['a.JPG', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.gif', 'image/gif'],
    ['a.pdf', 'application/pdf'],
    ['a.xml', 'application/xml'],
    ['a.txt', 'text/plain'],
    ['a.json', 'application/json'],
    ['a.zip', 'application/zip'],
    ['a', 'application/octet-stream'],
  ])('maps %s to %s', (path, expected) => {
    expect(contentTypeForPath(path)).toBe(expected);
  });
});
