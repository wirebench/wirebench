/**
 * `resolveItem` on a reference into a placeholder: the container is there but this build did not
 * load it, and the refusal says which kind it is and why.
 */
import { createProject } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { OpsError } from '../../../src/ops/errors.js';
import { resolveItem } from '../../../src/ops/items.js';

const project: Project = {
  ...createProject('Placeholders', { id: 'p1' }),
  unsupported: [
    { dir: 'apis', slug: 'Graph', kind: 'graphql', reason: 'unknown-kind', name: 'Graph API', order: 0 },
    { dir: 'apis', slug: 'Greeter', kind: 'grpc', reason: 'feature-disabled' },
  ],
};

function refusal(ref: string): { readonly code: string; readonly message: string } {
  try {
    resolveItem(project, ref);
  } catch (error) {
    if (error instanceof OpsError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error(`"${ref}" resolved to a request`);
}

describe('resolveItem and placeholders', () => {
  it('names the kind of a container this build has no protocol for, by its display name', () => {
    expect(refusal('Graph API/Query')).toEqual({
      code: 'unsupported-kind',
      message:
        '"Graph API/Query" is in "Graph API", a "graphql" container this build did not load: it has no such protocol',
    });
  });

  it('names a container whose protocol is switched off, by its folder on disk', () => {
    expect(refusal('apis/Greeter/requests/Hello')).toEqual({
      code: 'unsupported-kind',
      message:
        '"apis/Greeter/requests/Hello" is in "Greeter", a "grpc" container this build did not load: that protocol is switched off',
    });
  });

  it('still says not found for a reference into nothing', () => {
    expect(refusal('Nowhere/Nothing').code).toBe('item-not-found');
  });
});
