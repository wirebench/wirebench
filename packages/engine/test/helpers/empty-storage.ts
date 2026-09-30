import { extraContainersOf } from '../../src/project/model.js';
import type { ContainerDir, ProtocolStorage } from '../../src/protocol/module.js';

/**
 * A storage facet for a test module that is not about storage: it loads nothing, writes nothing,
 * manages nothing, and keeps its containers in `extraContainers[kind]`.
 */
export function emptyStorage(kind: string, dir: ContainerDir = 'apis'): ProtocolStorage {
  return {
    dir,
    load: () => Promise.resolve(undefined),
    files: () => new Map<string, string>(),
    managed: () => Promise.resolve([]),
    containers: (project) => extraContainersOf(project, kind),
    withContainers: (project, containers) => ({
      ...project,
      extraContainers: { ...project.extraContainers, [kind]: containers },
    }),
  };
}
