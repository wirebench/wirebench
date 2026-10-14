import { describe, expect, it } from 'vitest';
import { createProject, ProjectError } from '@wirebench/engine';
import { MAIN_KINDS } from '../src/main/kinds/kind-main.js';
import { applyChange, CORE_CHANGE_KINDS } from '../src/main/project-mutations.js';
import type { MutationDeps } from '../src/main/project-mutations.js';
import { projectChangeSchema } from '../src/shared/wire-types.js';
import type { ProjectChange } from '../src/shared/wire-types.js';

const ALL_CHANGE_KINDS = projectChangeSchema.options.map((option) => option.shape.kind.value);

/** The changes of a kind whose main half is not built yet (MCP, #79): on the wire, owned by no one until it is. */
const NO_MAIN_HALF_YET = /-mcp-/;

const deps: MutationDeps = {
  generate: () => Promise.reject(new Error('not used')),
};

describe('change kind ownership (spec §5.2)', () => {
  it('gives every change kind exactly one owner: core or one kind', () => {
    const owners = new Map<string, string[]>();
    const own = (changeKind: string, owner: string): void => {
      owners.set(changeKind, [...(owners.get(changeKind) ?? []), owner]);
    };
    for (const changeKind of CORE_CHANGE_KINDS) own(changeKind, 'core');
    for (const kind of MAIN_KINDS) {
      for (const changeKind of Object.keys(kind.mutations)) own(changeKind, kind.kind);
    }
    const missing = ALL_CHANGE_KINDS.filter(
      (changeKind) => !owners.has(changeKind) && !NO_MAIN_HALF_YET.test(changeKind),
    );
    const shared = [...owners].filter(([, by]) => by.length > 1);
    const unknown = [...owners.keys()].filter((changeKind) => !ALL_CHANGE_KINDS.includes(changeKind as never));
    expect({ missing, shared, unknown }).toEqual({ missing: [], shared: [], unknown: [] });
  });

  it('refuses a change kind no one owns with unknown-change', async () => {
    const change = { kind: 'no-such-change' } as unknown as ProjectChange;
    const error = await applyChange(createProject('P'), change, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe('unknown-change');
  });

  it('applies each core change kind itself', async () => {
    for (const kind of CORE_CHANGE_KINDS) {
      const change = { kind } as unknown as ProjectChange;
      const error = await Promise.resolve()
        .then(() => applyChange(createProject('P'), change, deps))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error instanceof ProjectError ? error.code : undefined, kind).not.toBe('unknown-change');
    }
  });
});
