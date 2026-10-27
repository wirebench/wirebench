/**
 * A kind this run switched off (`WIREBENCH_KINDS`) changes nothing: the engine neither loads nor saves
 * what it keeps, so a change through it would alter the model and then be dropped by the save. Main
 * refuses it with `feature-disabled`, as the engine refuses a feature that is off.
 */
import { describe, expect, it } from 'vitest';
import { createProject, ProjectError, type Project } from '@wirebench/engine';
import { MAIN_KINDS } from '../src/kinds/kind-main.js';
import { applyChange, type MutationDeps } from '../src/project-mutations.js';
import { KINDS, type KindId } from '@wirebench/wire/kinds/kind-module';
import type { ProjectChange } from '@wirebench/wire/wire-types';

const ALL: readonly KindId[] = KINDS.map((kind) => kind.kind);

function depsWithout(kind: KindId): MutationDeps {
  return {
    generate: () => Promise.reject(new Error('not used')),
    enabledKinds: ALL.filter((candidate) => candidate !== kind),
  };
}

async function refusal(project: Project, change: ProjectChange, deps: MutationDeps): Promise<unknown> {
  return Promise.resolve()
    .then(() => applyChange(project, change, deps))
    .then(
      () => undefined,
      (caught: unknown) => caught,
    );
}

/** One API of each kind, made while every kind is on, and the folder change it takes. */
const API_OF: Readonly<Record<string, ProjectChange>> = {
  rest: { kind: 'add-api', name: 'Shop', baseUrl: 'https://shop.test' },
  grpc: { kind: 'add-grpc-api', name: 'Greeter', target: 'localhost:50051' },
  websocket: { kind: 'add-ws-api', name: 'Chat', url: 'wss://chat.test' },
  mcp: { kind: 'add-mcp-server', name: 'Files' },
};

describe('a change through a kind that is off', () => {
  it.each(MAIN_KINDS.map((kind) => [kind.kind, kind] as const))(
    'is refused with feature-disabled for every change %s owns',
    async (kindId, kind) => {
      const feature = KINDS.find((candidate) => candidate.kind === kindId)?.feature.id;
      for (const changeKind of Object.keys(kind.mutations)) {
        const error = await refusal(createProject('P'), { kind: changeKind } as ProjectChange, depsWithout(kindId));
        expect(error, changeKind).toBeInstanceOf(ProjectError);
        expect((error as ProjectError).code, changeKind).toBe('feature-disabled');
        expect((error as ProjectError).details, changeKind).toEqual({ feature });
      }
    },
  );

  it.each(Object.entries(API_OF))('is refused for a folder in a %s API', async (kindId, add) => {
    const on: MutationDeps = { generate: () => Promise.reject(new Error('not used')) };
    const made = await applyChange(createProject('P'), add, on);
    const apiId = made.createdId;
    expect(apiId).toBeDefined();
    const error = await refusal(
      made.project,
      { kind: 'add-folder', apiId: apiId ?? '', name: 'Orders' },
      depsWithout(kindId as KindId),
    );
    expect((error as ProjectError).code).toBe('feature-disabled');
  });

  it('is applied when the kind is on', async () => {
    const deps = depsWithout('grpc');
    const { project } = await applyChange(createProject('P'), API_OF.rest!, deps);
    expect(project).not.toEqual(createProject('P'));
  });
});
