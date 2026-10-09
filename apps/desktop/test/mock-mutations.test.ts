// @vitest-environment node
/**
 * The `*-mock` project changes (#59): what they make, that every edit is held to the rules a mock file
 * from a teammate is, and that a new slug stays clear of a mock folder this build refused.
 */
import { describe, expect, it } from 'vitest';
import { createMock, createMockOperation, createMockResponse, createProject } from '@wirebench/engine';
import type { MockDef, Project } from '@wirebench/engine';
import {
  addMock,
  addMockResponse,
  duplicateMock,
  moveMockResponse,
  refusedMockSlugs,
  removeMock,
  removeMockResponse,
  toMockWire,
  updateMock,
  updateMockOperation,
  updateMockResponse,
} from '../src/main/project-mock-mutations.js';

function generated(name: string): MockDef {
  const accepted = createMockResponse('Accepted', { id: 'R1', body: 'xml', bodyText: '<ok/>' });
  return createMock(
    name,
    { containerId: 'C1', binding: '{urn:orders}OrderSoap' },
    {
      id: 'M1',
      operations: [
        createMockOperation('PlaceOrder', 'PlaceOrder', { id: 'O1', defaultResponseId: 'R1', responses: [accepted] }),
      ],
    },
  );
}

const generate = (containerId: string, name: string): Promise<MockDef> => {
  expect(containerId).toBe('C1');
  return Promise.resolve(generated(name));
};

async function withMock(): Promise<Project> {
  return (await addMock(createProject('P', { id: 'P1' }), { containerId: 'C1', name: 'Orders' }, generate)).project;
}

describe('mock mutations', () => {
  it('generates a mock, slugged after the others and clear of refused folders', async () => {
    const reserved = refusedMockSlugs([{ code: 'mock-version-too-new', file: 'mocks/Orders/mock.yaml' }]);
    expect([...reserved]).toEqual(['Orders']);
    const added = await addMock(createProject('P'), { containerId: 'C1', name: 'Orders' }, generate, reserved);
    expect(added.createdId).toBe('M1');
    expect(added.project.mocks.map((mock) => [mock.slug, mock.order])).toEqual([['Orders-2', 0]]);
    await expect(addMock(createProject('P'), { containerId: 'C1', name: 'X' }, undefined)).rejects.toMatchObject({
      code: 'mock-generate-unavailable',
    });
  });

  it('updates settings, renaming the folder, and refuses what a load would refuse', async () => {
    const project = await withMock();
    const next = updateMock(project, 'M1', { name: 'Shop', port: 9090, path: '/shop', validation: 'report' }).project;
    expect(next.mocks[0]).toMatchObject({
      name: 'Shop',
      slug: 'Shop',
      port: 9090,
      path: '/shop',
      validation: 'report',
    });
    expect(() => updateMock(project, 'M1', { path: 'no-slash' })).toThrow(
      expect.objectContaining({ code: 'mock-invalid' }),
    );
    expect(() => updateMock(project, 'nope', {})).toThrow(expect.objectContaining({ code: 'unknown-entity' }));
  });

  it('edits an operation: dispatch, default and script, with null clearing', async () => {
    const project = await withMock();
    const scripted = updateMockOperation(project, 'M1', 'O1', { dispatch: 'script', script: 'respond("Accepted")' });
    expect(scripted.project.mocks[0]?.operations[0]).toMatchObject({
      dispatch: 'script',
      script: 'respond("Accepted")',
    });
    const cleared = updateMockOperation(scripted.project, 'M1', 'O1', { defaultResponseId: null, script: null });
    expect(cleared.project.mocks[0]?.operations[0]?.defaultResponseId).toBeUndefined();
    expect(cleared.project.mocks[0]?.operations[0]?.script).toBeUndefined();
    expect(() => updateMockOperation(project, 'M1', 'O1', { defaultResponseId: 'missing' })).toThrow(
      expect.objectContaining({ code: 'unknown-entity' }),
    );
  });

  it('adds, copies, edits, moves and removes responses', async () => {
    let project = await withMock();
    const added = addMockResponse(project, 'M1', 'O1');
    project = added.project;
    const copied = addMockResponse(project, 'M1', 'O1', 'R1');
    project = copied.project;
    const names = (): string[] => project.mocks[0]?.operations[0]?.responses.map((response) => response.name) ?? [];
    expect(names()).toEqual(['Accepted', 'Response 2', 'Accepted copy']);

    project = updateMockResponse(project, 'M1', 'O1', added.createdId ?? '', {
      name: 'Out of stock',
      status: 500,
      headers: [{ name: 'X-Trace', value: 'mock' }],
      body: 'json',
      bodyText: '{"error":"stock"}',
      match: [{ from: 'query', name: 'sku', equals: 'SKU-0', matches: undefined }],
      scenario: { name: 'stock', state: 'Empty', next: 'Restocked' },
    }).project;
    const edited = project.mocks[0]?.operations[0]?.responses[1];
    expect(edited).toMatchObject({ slug: 'Out of stock', status: 500, body: 'json', scenario: { name: 'stock' } });
    expect(edited?.match).toEqual([{ from: 'query', name: 'sku', equals: 'SKU-0' }]);
    expect(() =>
      updateMockResponse(project, 'M1', 'O1', 'R1', { headers: [{ name: 'X-A', value: 'a\r\nb' }] }),
    ).toThrow(expect.objectContaining({ code: 'mock-invalid' }));
    expect(() => updateMockResponse(project, 'M1', 'O1', 'R1', { scenario: { name: 'bad name' } })).toThrow(
      expect.objectContaining({ code: 'mock-invalid' }),
    );

    project = moveMockResponse(project, 'M1', 'O1', copied.createdId ?? '', 0).project;
    expect(names()).toEqual(['Accepted copy', 'Accepted', 'Out of stock']);
    expect(project.mocks[0]?.operations[0]?.responses.map((response) => response.order)).toEqual([0, 1, 2]);

    project = removeMockResponse(project, 'M1', 'O1', 'R1').project;
    expect(names()).toEqual(['Accepted copy', 'Out of stock']);
    expect(project.mocks[0]?.operations[0]?.defaultResponseId).toBeUndefined();
  });

  it('duplicates with new ids and the default pointed at its copy, and removes', async () => {
    const project = await withMock();
    const duplicated = duplicateMock(project, 'M1');
    const copy = duplicated.project.mocks[1];
    expect(copy).toMatchObject({ name: 'Orders copy', slug: 'Orders copy', order: 1 });
    expect(copy?.id).not.toBe('M1');
    const operation = copy?.operations[0];
    expect(operation?.id).not.toBe('O1');
    expect(operation?.defaultResponseId).toBe(operation?.responses[0]?.id);
    expect(operation?.defaultResponseId).not.toBe('R1');
    expect(removeMock(duplicated.project, 'M1').project.mocks.map((mock) => [mock.name, mock.order])).toEqual([
      ['Orders copy', 0],
    ]);
  });

  it('puts a mock on the wire as the model holds it', async () => {
    const project = await withMock();
    expect(toMockWire(project.mocks[0] as MockDef)).toMatchObject({
      id: 'M1',
      source: { containerId: 'C1', binding: '{urn:orders}OrderSoap' },
      operations: [{ id: 'O1', defaultResponseId: 'R1', responses: [{ id: 'R1', body: 'xml', bodyText: '<ok/>' }] }],
    });
  });
});
