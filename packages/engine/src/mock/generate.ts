/**
 * A new mock generated from an interface or API (spec §Generating a mock): one operation per contract
 * operation, each with one `Default` response that is also its default, from the container's cached
 * definition and nothing else. The mock is returned, not saved: the host adds it to the project.
 */

import { WirebenchError } from '../errors.js';
import { defaultRegistry } from '../protocols.js';
import { nodeFs } from '../project/fs.js';
import type { FsLike } from '../project/fs.js';
import type { CreateOptions, Project } from '../project/model.js';
import { generateId } from '../project/model.js';
import { uniqueSlug } from '../project/paths.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import type { ProtocolMocking } from './contract.js';
import { createMock, createMockOperation, createMockResponse } from './model.js';
import type { MockDef } from './model.js';

/**
 * The mock facet of the protocol that holds `containerId`.
 *
 * @throws WirebenchError `mock-container-missing`, `mock-protocol-unsupported`
 */
export function mockFacetFor(
  project: Project,
  containerId: string,
  registry: ProtocolRegistry,
): { readonly facet: ProtocolMocking; readonly kind: string } {
  for (const module of registry.modules) {
    const container = module.storage.containers(project).find((item) => item.id === containerId);
    if (container === undefined) continue;
    if (module.mock === undefined) {
      throw new WirebenchError(
        'mock-protocol-unsupported',
        `"${container.name}" is a ${module.kind} container; mocks serve SOAP and REST only`,
        { details: { kind: module.kind } },
      );
    }
    return { facet: module.mock, kind: module.kind };
  }
  throw new WirebenchError('mock-container-missing', `The project has no interface or API with id ${containerId}`, {
    details: { containerId },
  });
}

export interface GenerateMockOptions extends Pick<CreateOptions, 'newId'> {
  readonly name: string;
  /** SOAP: the binding to speak, in Clark notation; the first SOAP 1.1 binding when absent. */
  readonly binding?: string;
  readonly fs?: FsLike;
  readonly registry?: ProtocolRegistry;
}

/**
 * Generates a mock of the container `containerId`, slugged and ordered after the project's mocks.
 *
 * @throws WirebenchError `mock-container-missing`, `mock-protocol-unsupported`,
 * `mock-definition-missing`, `mock-binding-unknown`
 */
export async function generateMock(
  project: Project,
  root: string,
  containerId: string,
  options: GenerateMockOptions,
): Promise<MockDef> {
  const { facet } = mockFacetFor(project, containerId, options.registry ?? defaultRegistry());
  const generated = await facet.generate({
    project,
    root,
    fs: options.fs ?? nodeFs,
    containerId,
    ...(options.binding !== undefined ? { binding: options.binding } : {}),
  });
  const newId = options.newId ?? generateId;
  const operationSlugs = new Set<string>();
  const operations = generated.operations.map((operation, index) => {
    const slug = uniqueSlug(operation.name, operationSlugs);
    operationSlugs.add(slug);
    const response = createMockResponse('Default', {
      newId,
      slug: 'Default',
      status: operation.response.status,
      body: operation.response.body,
      bodyText: operation.response.bodyText,
      ...(operation.response.headers !== undefined ? { headers: operation.response.headers } : {}),
    });
    return createMockOperation(operation.name, operation.key, {
      newId,
      slug,
      order: index,
      defaultResponseId: response.id,
      responses: [response],
    });
  });
  const order = project.mocks.reduce((highest, mock) => Math.max(highest, mock.order + 1), 0);
  return createMock(
    options.name,
    { containerId, ...(generated.binding !== undefined ? { binding: generated.binding } : {}) },
    {
      newId,
      slug: uniqueSlug(options.name, new Set(project.mocks.map((mock) => mock.slug))),
      order,
      operations,
    },
  );
}
