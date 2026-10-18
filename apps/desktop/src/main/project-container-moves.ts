/**
 * Moving an API container (#701): reordering it among its project's APIs, and taking it out of one
 * project's model to place it in another's with every id kept. Pure, like `project-mutations.ts`;
 * `WorkspaceService.moveApiToProject` owns the two hosts and the files.
 *
 * Only the APIs of every kind (REST, gRPC, WebSocket, MCP — the containers under `apis/`) take part.
 * A SOAP interface stays where it is: the explorer places interfaces by their own list, so an API
 * reorder hands the APIs' existing `order` values out again in the new sequence and the interleaving
 * with interfaces does not change.
 */

import { ProjectError, nextApiOrder, uniqueSlug } from '@wirebench/engine';
import type { ContainerBase, MockDef, Project } from '@wirebench/engine';
import { notFound, takenApiSlugs } from './project-api-mutations.js';

/** The kind whose containers are interfaces under `interfaces/`, not APIs. */
const INTERFACE_KIND = 'soap';

/** Every API container of every kind with its kind, in explorer order: by `order`, ties in kind order. */
function apiEntries(project: Project): { readonly kind: string; readonly container: ContainerBase }[] {
  return Object.entries(project.containers)
    .filter(([kind]) => kind !== INTERFACE_KIND)
    .flatMap(([kind, containers]) => containers.map((container) => ({ kind, container })))
    .sort((left, right) => left.container.order - right.container.order);
}

/** Whether `project` holds an API (of any kind) with this id. */
export function holdsApi(project: Project, apiId: string): boolean {
  return apiEntries(project).some((entry) => entry.container.id === apiId);
}

/** The API that follows `apiId` among the project's APIs, or `undefined` when it is the last one. */
export function apiAfter(project: Project, apiId: string): string | undefined {
  const entries = apiEntries(project);
  const at = entries.findIndex((entry) => entry.container.id === apiId);
  return at === -1 ? undefined : entries[at + 1]?.container.id;
}

/**
 * `project` with API `apiId` placed right before `beforeApiId` among the project's APIs, or after
 * the last one when that is absent. The APIs' `order` values are handed out again in the new
 * sequence (made strictly increasing), so nothing else in the project moves. The same project back
 * when nothing changes.
 *
 * @throws ProjectError `project-entity-not-found` when either id names no API here.
 */
export function reorderApi(project: Project, apiId: string, beforeApiId?: string): Project {
  const entries = apiEntries(project);
  const moving = entries.find((entry) => entry.container.id === apiId);
  if (moving === undefined) notFound('API', apiId);
  if (beforeApiId === apiId) return project;
  const others = entries.filter((entry) => entry !== moving);
  const at =
    beforeApiId === undefined ? others.length : others.findIndex((entry) => entry.container.id === beforeApiId);
  if (at === -1) notFound('API', beforeApiId as string);
  const arranged = [...others.slice(0, at), moving, ...others.slice(at)];

  const slots: number[] = [];
  for (const entry of entries) {
    const previous = slots.at(-1);
    slots.push(previous === undefined ? entry.container.order : Math.max(entry.container.order, previous + 1));
  }
  const orderOf = new Map(arranged.map((entry, index) => [entry.container.id, slots[index] as number]));
  if (arranged.every((entry) => entry.container.order === orderOf.get(entry.container.id))) return project;

  const containers = Object.fromEntries(
    Object.entries(project.containers).map(([kind, list]) => [
      kind,
      kind === INTERFACE_KIND
        ? list
        : list.map((container) => {
            const order = orderOf.get(container.id);
            return order === undefined || order === container.order ? container : { ...container, order };
          }),
    ]),
  );
  return { ...project, containers };
}

/** One API as it travels between projects: its container (folders, requests, scripts) and its mocks. */
export interface ApiSlice {
  readonly kind: string;
  readonly container: ContainerBase;
  readonly mocks: readonly MockDef[];
}

/**
 * Takes API `apiId` and the mocks that implement it out of `project`.
 *
 * @throws ProjectError `project-entity-not-found` when no API here has that id.
 */
export function takeApi(project: Project, apiId: string): { readonly project: Project; readonly slice: ApiSlice } {
  const entry = apiEntries(project).find((candidate) => candidate.container.id === apiId);
  if (entry === undefined) notFound('API', apiId);
  const mocks = project.mocks.filter((mock) => mock.source.containerId === apiId);
  const remaining = (project.containers[entry.kind] ?? []).filter((container) => container.id !== apiId);
  const containers = Object.fromEntries(
    Object.entries({ ...project.containers, [entry.kind]: remaining }).filter(([, list]) => list.length > 0),
  );
  return {
    project: { ...project, containers, mocks: project.mocks.filter((mock) => !mocks.includes(mock)) },
    slice: { kind: entry.kind, container: entry.container, mocks },
  };
}

/**
 * `project` with `slice` placed in it, every id kept: after its last API, or before `beforeApiId`.
 * The container and its mocks take a slug free in this project, keeping their own when it is;
 * `strayFolders` adds names under `apis/` on disk that the model does not know.
 *
 * @throws ProjectError `project-move-id-clash` when this project already holds the API or one of
 *   its mocks, `project-entity-not-found` when `beforeApiId` names no API here.
 */
export function placeApi(
  project: Project,
  slice: ApiSlice,
  beforeApiId?: string,
  strayFolders: ReadonlySet<string> = new Set(),
): Project {
  const mockIds = new Set(project.mocks.map((mock) => mock.id));
  if (holdsApi(project, slice.container.id) || slice.mocks.some((mock) => mockIds.has(mock.id))) {
    throw new ProjectError('project-move-id-clash', 'The target project already holds this API', {
      details: { apiId: slice.container.id },
    });
  }
  const container: ContainerBase = {
    ...slice.container,
    slug: uniqueSlug(slice.container.slug, new Set([...takenApiSlugs(project), ...strayFolders])),
    order: nextApiOrder(project),
  };
  const takenMockSlugs = new Set(project.mocks.map((mock) => mock.slug));
  let mockOrder = project.mocks.reduce((highest, mock) => Math.max(highest, mock.order), -1);
  const mocks = slice.mocks.map((mock) => {
    const slug = uniqueSlug(mock.slug, takenMockSlugs);
    takenMockSlugs.add(slug);
    mockOrder += 1;
    return { ...mock, slug, order: mockOrder };
  });
  const placed: Project = {
    ...project,
    containers: { ...project.containers, [slice.kind]: [...(project.containers[slice.kind] ?? []), container] },
    mocks: [...project.mocks, ...mocks],
  };
  return beforeApiId === undefined ? placed : reorderApi(placed, container.id, beforeApiId);
}
