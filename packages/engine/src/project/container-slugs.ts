/**
 * The slugs a project's containers hold, by directory. Kept apart from `model.ts`, which every
 * module imports, because it asks the registry where each kind is stored.
 */

import type { ContainerDir } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { Project } from './model.js';
import { unsupportedOf } from './model.js';

/**
 * Every slug in use under one of the two container directories: the containers the project holds
 * there, and the placeholders (spec §6). A save keeps exactly these directories, whatever its
 * registry can write. Hand it to `uniqueSlug` when naming a new container, so a save never has to
 * refuse it with `container-slug-conflict`.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function takenContainerSlugs(
  project: Project,
  dir: ContainerDir,
  registry: ProtocolRegistry = defaultRegistry(),
): ReadonlySet<string> {
  // A kind with no enabled module holds no containers (its directories load as placeholders), so a
  // container whose module is not found was put there by the host: it is counted under `apis`, which
  // is where every protocol after SOAP keeps its containers.
  const dirOf = (kind: string): ContainerDir => registry.find(kind)?.storage.dir ?? 'apis';
  const containers = Object.entries(project.containers)
    .filter(([kind]) => dirOf(kind) === dir)
    .flatMap(([, list]) => list);
  return new Set([
    ...containers.map((container) => container.slug),
    ...unsupportedOf(project)
      .filter((placeholder) => placeholder.dir === dir)
      .map((placeholder) => placeholder.slug),
  ]);
}
