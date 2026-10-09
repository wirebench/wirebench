/**
 * The `*-mock` project changes, and the wire form of a mock (#59).
 *
 * Every edit is checked by the engine's own file parsers before it is accepted (`validateMock`), so the
 * limits, the header rules and the scenario-name pattern hold for an edit made here exactly as they
 * hold for a file pulled from a teammate; the IPC schema checks structure only.
 */

import {
  ProjectError,
  createMockResponse,
  generateId,
  isWirebenchError,
  uniqueSlug,
  validateMock,
} from '@wirebench/engine';
import type { MockDef, MockMatch, MockOperation, MockResponse, MockScenarioStep, Project } from '@wirebench/engine';
import type { MockOperationPatch, MockPatch, MockResponsePatch, MockWire } from '../shared/wire-types.js';

/** The outcome of one mock change. */
export interface MockMutationResult {
  readonly project: Project;
  readonly createdId?: string;
}

/** Generates a new mock of a container from its cached definition; the host supplies it. */
export type GenerateMockFn = (containerId: string, name: string, binding?: string) => Promise<MockDef>;

function unknown(what: string, id: string): never {
  throw new ProjectError('unknown-entity', `No ${what} with id "${id}"`, { details: { id } });
}

function requireMock(project: Project, mockId: string): MockDef {
  return project.mocks.find((mock) => mock.id === mockId) ?? unknown('mock', mockId);
}

function requireOperation(mock: MockDef, operationId: string): MockOperation {
  return mock.operations.find((operation) => operation.id === operationId) ?? unknown('mock operation', operationId);
}

function requireResponse(operation: MockOperation, responseId: string): MockResponse {
  return operation.responses.find((response) => response.id === responseId) ?? unknown('mock response', responseId);
}

/**
 * The slugs a new or renamed mock may not take: every other mock's, and `reserved`, the folders under
 * `mocks/` this build could not load. Taking one of those would make the next save refuse
 * (`mock-file-conflict`) rather than write over files the user has not seen.
 */
function takenSlugs(project: Project, reserved: ReadonlySet<string>, except?: string): Set<string> {
  return new Set([...project.mocks.filter((mock) => mock.id !== except).map((mock) => mock.slug), ...reserved]);
}

function renumber<T extends { readonly order: number }>(items: readonly T[]): T[] {
  return items.map((item, order) => (item.order === order ? item : { ...item, order }));
}

/** `mock` as its files would load, or a `mock-invalid` error naming what is wrong. */
function validated(mock: MockDef): MockDef {
  try {
    validateMock(mock);
    return mock;
  } catch (error) {
    if (isWirebenchError(error) && error.code === 'mock-file-invalid') {
      const issues = (error.details?.['issues'] as readonly { path: string; message: string }[] | undefined) ?? [];
      const detail = issues.map((issue) => (issue.path !== '' ? `${issue.path}: ${issue.message}` : issue.message));
      throw new ProjectError('mock-invalid', `The mock is not valid: ${detail.join('; ') || error.message}`, {
        details: { issues },
      });
    }
    throw error;
  }
}

function replaceMock(project: Project, next: MockDef): Project {
  const checked = validated(next);
  return { ...project, mocks: project.mocks.map((mock) => (mock.id === next.id ? checked : mock)) };
}

function replaceOperation(mock: MockDef, next: MockOperation): MockDef {
  return { ...mock, operations: mock.operations.map((operation) => (operation.id === next.id ? next : operation)) };
}

/** Drops `undefined` members, which the wire allows and the engine's exact optional types do not. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Generates a mock of `containerId` and adds it at the end of the project's list. */
export async function addMock(
  project: Project,
  input: { readonly containerId: string; readonly name: string; readonly binding?: string | undefined },
  generate: GenerateMockFn | undefined,
  reserved: ReadonlySet<string> = new Set(),
): Promise<MockMutationResult> {
  if (generate === undefined) {
    throw new ProjectError('mock-generate-unavailable', 'A mock can only be generated in an open project');
  }
  const generated = await generate(input.containerId, input.name, input.binding);
  const mock = validated({
    ...generated,
    slug: uniqueSlug(input.name, takenSlugs(project, reserved)),
    order: project.mocks.length,
  });
  return { project: { ...project, mocks: [...project.mocks, mock] }, createdId: mock.id };
}

/** Applies a settings patch; a new name takes a new slug, so the folder is renamed. */
export function updateMock(
  project: Project,
  mockId: string,
  patch: MockPatch,
  reserved: ReadonlySet<string> = new Set(),
): MockMutationResult {
  const current = requireMock(project, mockId);
  const name = patch.name ?? current.name;
  const description = patch.description ?? current.description;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { description: _dropped, ...rest } = current;
  const next: MockDef = {
    ...rest,
    name,
    slug: name !== current.name ? uniqueSlug(name, takenSlugs(project, reserved, mockId)) : current.slug,
    ...(description !== undefined && description !== '' ? { description } : {}),
    port: patch.port ?? current.port,
    path: patch.path ?? current.path,
    validation: patch.validation ?? current.validation,
  };
  return { project: replaceMock(project, next) };
}

export function updateMockOperation(
  project: Project,
  mockId: string,
  operationId: string,
  patch: MockOperationPatch,
): MockMutationResult {
  const mock = requireMock(project, mockId);
  const operation = requireOperation(mock, operationId);
  if (patch.defaultResponseId !== undefined && patch.defaultResponseId !== null) {
    requireResponse(operation, patch.defaultResponseId);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { defaultResponseId: _default, script: _script, ...rest } = operation;
  const defaultResponseId =
    patch.defaultResponseId === undefined ? operation.defaultResponseId : (patch.defaultResponseId ?? undefined);
  const script = patch.script === undefined ? operation.script : (patch.script ?? undefined);
  const next: MockOperation = {
    ...rest,
    dispatch: patch.dispatch ?? operation.dispatch,
    ...(defaultResponseId !== undefined ? { defaultResponseId } : {}),
    ...(script !== undefined ? { script } : {}),
  };
  return { project: replaceMock(project, replaceOperation(mock, next)) };
}

/** Adds a response at the end of an operation: a copy of `copyOf`, or an empty 200. */
export function addMockResponse(
  project: Project,
  mockId: string,
  operationId: string,
  copyOf?: string,
): MockMutationResult {
  const mock = requireMock(project, mockId);
  const operation = requireOperation(mock, operationId);
  const taken = new Set(operation.responses.map((response) => response.slug));
  const source = copyOf !== undefined ? requireResponse(operation, copyOf) : undefined;
  const name = source !== undefined ? `${source.name} copy` : `Response ${operation.responses.length + 1}`;
  const response: MockResponse =
    source !== undefined
      ? { ...source, id: generateId(), name, slug: uniqueSlug(name, taken), order: operation.responses.length }
      : createMockResponse(name, { slug: uniqueSlug(name, taken), order: operation.responses.length });
  const next: MockOperation = { ...operation, responses: [...operation.responses, response] };
  return { project: replaceMock(project, replaceOperation(mock, next)), createdId: response.id };
}

export function updateMockResponse(
  project: Project,
  mockId: string,
  operationId: string,
  responseId: string,
  patch: MockResponsePatch,
): MockMutationResult {
  const mock = requireMock(project, mockId);
  const operation = requireOperation(mock, operationId);
  const current = requireResponse(operation, responseId);
  const name = patch.name ?? current.name;
  const taken = new Set(
    operation.responses.filter((response) => response.id !== responseId).map((response) => response.slug),
  );
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { scenario: _scenario, ...rest } = current;
  const scenario = patch.scenario === undefined ? current.scenario : (patch.scenario ?? undefined);
  const body = patch.body ?? current.body;
  const next: MockResponse = {
    ...rest,
    name,
    slug: name !== current.name ? uniqueSlug(name, taken) : current.slug,
    status: patch.status ?? current.status,
    headers: patch.headers ?? current.headers,
    delayMs: patch.delayMs ?? current.delayMs,
    body,
    bodyText: body === 'none' ? '' : (patch.bodyText ?? current.bodyText),
    match: patch.match === undefined ? current.match : patch.match.map((condition) => defined(condition) as MockMatch),
    ...(scenario !== undefined ? { scenario: defined(scenario) as MockScenarioStep } : {}),
  };
  const responses = operation.responses.map((response) => (response.id === responseId ? next : response));
  return { project: replaceMock(project, replaceOperation(mock, { ...operation, responses })) };
}

/** Removes a response; an operation whose default it was loses its default. */
export function removeMockResponse(
  project: Project,
  mockId: string,
  operationId: string,
  responseId: string,
): MockMutationResult {
  const mock = requireMock(project, mockId);
  const operation = requireOperation(mock, operationId);
  requireResponse(operation, responseId);
  const { defaultResponseId, ...rest } = operation;
  const next: MockOperation = {
    ...rest,
    ...(defaultResponseId !== undefined && defaultResponseId !== responseId ? { defaultResponseId } : {}),
    responses: renumber(operation.responses.filter((response) => response.id !== responseId)),
  };
  return { project: replaceMock(project, replaceOperation(mock, next)) };
}

/** Moves a response to index `to`: the order match and sequence dispatch try them in. */
export function moveMockResponse(
  project: Project,
  mockId: string,
  operationId: string,
  responseId: string,
  to: number,
): MockMutationResult {
  const mock = requireMock(project, mockId);
  const operation = requireOperation(mock, operationId);
  const moving = requireResponse(operation, responseId);
  const others = operation.responses.filter((response) => response.id !== responseId);
  const index = Math.max(0, Math.min(others.length, Math.trunc(to)));
  const responses = renumber([...others.slice(0, index), moving, ...others.slice(index)]);
  return { project: replaceMock(project, replaceOperation(mock, { ...operation, responses })) };
}

/** Removes a mock; its folder goes on the next save. */
export function removeMock(project: Project, mockId: string): MockMutationResult {
  requireMock(project, mockId);
  return { project: { ...project, mocks: renumber(project.mocks.filter((mock) => mock.id !== mockId)) } };
}

/** Copies a mock under a new name, with new ids throughout and each default pointed at its copy. */
export function duplicateMock(
  project: Project,
  mockId: string,
  reserved: ReadonlySet<string> = new Set(),
): MockMutationResult {
  const source = requireMock(project, mockId);
  const name = `${source.name} copy`;
  const copy = validated({
    ...source,
    id: generateId(),
    name,
    slug: uniqueSlug(name, takenSlugs(project, reserved)),
    order: project.mocks.length,
    operations: source.operations.map((operation) => {
      const ids = new Map(operation.responses.map((response) => [response.id, generateId()]));
      const { defaultResponseId, ...rest } = operation;
      const copiedDefault = defaultResponseId !== undefined ? ids.get(defaultResponseId) : undefined;
      return {
        ...rest,
        id: generateId(),
        ...(copiedDefault !== undefined ? { defaultResponseId: copiedDefault } : {}),
        responses: operation.responses.map((response) => ({ ...response, id: ids.get(response.id) ?? generateId() })),
      };
    }),
  });
  return { project: { ...project, mocks: [...project.mocks, copy] }, createdId: copy.id };
}

/** The slugs of the mock folders a load refused, from its problems: what a new slug must avoid. */
export function refusedMockSlugs(problems: readonly { readonly code: string; readonly file: string }[]): Set<string> {
  const slugs = new Set<string>();
  for (const problem of problems) {
    const match = /^mocks\/([^/]+)\/mock\.yaml$/.exec(problem.file);
    if (problem.code.startsWith('mock-') && match?.[1] !== undefined) {
      slugs.add(match[1]);
    }
  }
  return slugs;
}

/** A mock as the renderer sees it. */
export function toMockWire(mock: MockDef): MockWire {
  return {
    id: mock.id,
    name: mock.name,
    slug: mock.slug,
    order: mock.order,
    ...(mock.description !== undefined ? { description: mock.description } : {}),
    source: { ...mock.source },
    port: mock.port,
    path: mock.path,
    validation: mock.validation,
    operations: mock.operations.map((operation) => ({
      id: operation.id,
      name: operation.name,
      slug: operation.slug,
      order: operation.order,
      operation: operation.operation,
      dispatch: operation.dispatch,
      ...(operation.defaultResponseId !== undefined ? { defaultResponseId: operation.defaultResponseId } : {}),
      ...(operation.script !== undefined ? { script: operation.script } : {}),
      responses: operation.responses.map((response) => ({
        id: response.id,
        name: response.name,
        slug: response.slug,
        order: response.order,
        status: response.status,
        headers: response.headers.map((header) => ({ ...header })),
        delayMs: response.delayMs,
        body: response.body,
        bodyText: response.bodyText,
        match: response.match.map((condition) => ({ ...condition })),
        ...(response.scenario !== undefined ? { scenario: { ...response.scenario } } : {}),
      })),
    })),
  };
}
