/**
 * `runSequences` looks a step's request up in the registry of the run context it is handed, the
 * same registry its sender sends through — not the built-in one.
 */
import {
  BUILTIN_PROTOCOLS,
  createGrpcApi,
  createGrpcRequest,
  createProject,
  createProtocolRegistry,
  unavailableCaptureSource,
} from '@wirebench/engine';
import type { ProtocolModule, ProtocolRegistry, Project, RunContext, SequenceDef } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { runSequences } from '../../src/commands/sequence.js';

const project: Project = {
  ...createProject('Registry', { id: 'proj-registry' }),
  grpcApis: [
    createGrpcApi('Greeter', {
      id: 'api-greeter',
      slug: 'greeter',
      order: 0,
      requests: [createGrpcRequest('Hello', { id: 'g-hello' })],
    }),
  ],
};

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

/**
 * The built-in protocols, with gRPC's run facet handing out its requests under another name: a step
 * looked up in this registry is named after it, one looked up in the built-in registry is not.
 */
function hostRegistry(): ProtocolRegistry {
  const modules = BUILTIN_PROTOCOLS.map((module): ProtocolModule => {
    const run = module.run;
    if (module.kind !== 'grpc' || run === undefined) {
      return module;
    }
    return {
      ...module,
      run: {
        ...run,
        groups: (project) =>
          run.groups(project).map((group) => ({
            ...group,
            candidates: group.candidates.map((candidate) => ({
              ...candidate,
              item: { ...candidate.item, request: { ...candidate.item.request, name: 'Hello (host registry)' } },
            })),
          })),
      },
    };
  });
  return createProtocolRegistry(modules, {
    features: [{ id: 'scripts', title: 'Scripts', default: true, stage: 'stable', requires: [] }],
  });
}

describe('runSequences', () => {
  it('looks its steps up in the run context’s registry', async () => {
    const context: RunContext = {
      project,
      projectDir: '/nowhere',
      overrides: {},
      getSecret: () => Promise.resolve(undefined),
      registry: hostRegistry(),
    };

    const result = await runSequences([sequence], context, {
      bail: false,
      requireAssertions: false,
      signal: new AbortController().signal,
      onStepDone: () => undefined,
      containsKnownSecret: () => false,
      captures: unavailableCaptureSource('not in this test'),
      onCallbackWaiting: () => undefined,
    });

    // A step with no name of its own is named after the request its lookup found.
    expect(result.requests.map((request) => request.name)).toEqual(['1. Hello (host registry)']);
  });
});
