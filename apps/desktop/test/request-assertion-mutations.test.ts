/**
 * `set-request-assertions` (request-assertions spec §5.2): one change for a SOAP, REST, gRPC or
 * WebSocket request's own assertions, validated by the engine's schema, shown on every request view.
 */
import { describe, expect, it } from 'vitest';
import {
  createApi,
  createGrpcApi,
  createGrpcRequest,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  createWsApi,
  createWsRequest,
  grpcApisOf,
  isWirebenchError,
  restApisOf,
  soapInterfacesOf,
} from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { applyChange } from '../src/main/project-mutations.js';
import type { MutationDeps } from '../src/main/project-mutations.js';
import { findGrpcRequest } from '../src/main/project-grpc-mutations.js';
import { findRestRequest } from '../src/main/project-rest-mutations.js';
import { findWsRequest } from '../src/main/project-ws-mutations.js';
import { findRequest } from '../src/main/project-wire.js';
import type { RequestAssertionWire } from '../src/shared/wire-types.js';

const deps: MutationDeps = {
  generate: () => Promise.resolve({ envelopeXml: '<Add/>', soapVersion: '1.1' }),
};

function build(): Project {
  return {
    ...createProject('Demo', { id: 'p1' }),
    containers: {
      soap: [
        createInterface('Calculator', {
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
        }),
      ],
      rest: [
        createApi('Shop', {
          id: 'api-1',
          baseUrl: 'http://shop.test',
          requests: [createRestRequest('Log in', { id: 'rest-1' })],
        }),
      ],
      grpc: [createGrpcApi('Greeter', { id: 'g-1', requests: [createGrpcRequest('Hello', { id: 'grpc-1' })] })],
      websocket: [
        createWsApi('Chat', {
          id: 'w-1',
          url: 'ws://chat.test',
          requests: [createWsRequest('Echo', { id: 'ws-1', url: '/echo' })],
        }),
      ],
    },
  };
}

const STATUS: RequestAssertionWire = { type: 'status', equals: 200 };
const SLA: RequestAssertionWire = { type: 'sla', maxMs: 500 };

const set = (project: Project, requestId: string, assertions: RequestAssertionWire[]) =>
  applyChange(project, { kind: 'set-request-assertions', requestId, assertions }, deps);

function assertionsOf(project: Project, id: string): unknown {
  return (
    findRequest(project, id)?.request.assertions ??
    findRestRequest(project, id)?.assertions ??
    findGrpcRequest(project, id)?.assertions ??
    findWsRequest(project, id)?.assertions
  );
}

describe('set-request-assertions', () => {
  it.each(['soap-1', 'rest-1', 'grpc-1', 'ws-1'])("replaces %s's assertions", async (id) => {
    const { project } = await set(build(), id, [STATUS, SLA]);
    expect(assertionsOf(project, id)).toEqual([STATUS, SLA]);
  });

  it('leaves the other protocols untouched', async () => {
    const before = build();
    const { project } = await set(before, 'ws-1', [STATUS]);
    expect(restApisOf(project)).toBe(restApisOf(before));
    expect(soapInterfacesOf(project)).toBe(soapInterfacesOf(before));
    expect(grpcApisOf(project)).toBe(grpcApisOf(before));
  });

  it('refuses an unknown request with unknown-entity', async () => {
    await expect(set(build(), 'nope', [STATUS])).rejects.toSatisfy(
      (error: unknown) => isWirebenchError(error) && error.code === 'unknown-entity',
    );
  });

  it('refuses a match with two checks, and a regex that does not compile', async () => {
    const bad = [
      { type: 'match', language: 'jsonpath', expression: '$', equals: 'a', exists: true },
      { type: 'match', language: 'jsonpath', expression: '$', matches: '(' },
    ] as RequestAssertionWire[];
    for (const assertion of bad) {
      await expect(set(build(), 'rest-1', [assertion])).rejects.toSatisfy(
        (error: unknown) => isWirebenchError(error) && error.code === 'request-assertions-invalid',
      );
    }
  });
});
