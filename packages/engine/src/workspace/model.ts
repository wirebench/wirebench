/**
 * The Wirebench workspace model: a container of projects with its own
 * environments (see the design spec, "Workspaces").
 *
 * A workspace does not own project data itself: each {@link WorkspaceProjectRef}
 * merely points at a project folder, either one Wirebench manages inside the
 * workspace (`source: 'internal'`) or an existing project folder elsewhere on
 * disk that the workspace only links to (`source: 'linked'`, always an
 * absolute {@link WorkspaceProjectRef.path}). Environments live on the
 * workspace, not the project: a workspace environment carries an endpoint
 * override per `<projectSlug>/<interfaceSlug>` and its own property overrides,
 * so the same set of projects can be pointed at different deployments without
 * editing any of them.
 *
 * Every field is `readonly`, mirroring `project/model.ts`.
 */

import type { CreateOptions, PropertyMap } from '../project/model.js';
import { generateId } from '../project/model.js';
import { uniqueSlug } from '../project/paths.js';

/** The on-disk format version written to (and required by) `workspace.yaml`. */
export const WORKSPACE_FORMAT_VERSION = 3;

/**
 * A pointer to one project inside a workspace. `internal` projects live under
 * the workspace's own `projects/` directory and are managed by it; `linked`
 * projects live at an existing, absolute `path` elsewhere on disk and the
 * workspace only references them — nothing here checks that the folder they
 * point at actually exists, or is a valid project; that is the main process's
 * job when it opens one.
 */
export interface WorkspaceProjectRef {
  readonly id: string;
  readonly slug: string;
  readonly source: 'internal' | 'linked';
  /** Absolute path to the project folder. Present for `source: 'linked'` only. */
  readonly path?: string;
}

/**
 * A named set of per-interface endpoint overrides and property values,
 * scoped to a workspace rather than to one project (compare
 * `project/model.ts`'s `Environment`). `endpoints` is keyed by
 * `<projectSlug>/<interfaceSlug>`.
 */
export interface WorkspaceEnvironment {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly properties: PropertyMap;
  readonly endpoints: Readonly<Record<string, string>>;
  /**
   * Names of {@link properties} entries that are switched off, mirroring
   * `project/model.ts`'s `Environment.disabledProperties`: resolution treats a disabled
   * property as absent, while its value stays on disk. Written sorted, deduplicated, and only
   * for names still present in `properties`.
   */
  readonly disabledProperties: readonly string[];
}

/** A whole Wirebench workspace, as loaded from (or saved to) a workspace folder. */
export interface Workspace {
  readonly formatVersion: typeof WORKSPACE_FORMAT_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** ISO 8601 timestamp of when the workspace was created. */
  readonly createdAt: string;
  readonly properties: PropertyMap;
  /** Names of {@link properties} entries switched off; see {@link WorkspaceEnvironment.disabledProperties}. */
  readonly disabledProperties: readonly string[];
  /**
   * Id of the environment currently active for this workspace, if any. Machine-local: kept only
   * in memory while a workspace is open, and never serialised into `workspace.yaml` — see
   * `local-state.ts`, which is where it actually lives on disk.
   */
  readonly activeEnvironmentId?: string;
  readonly projects: readonly WorkspaceProjectRef[];
  readonly environments: readonly WorkspaceEnvironment[];
}

function idOf(options: CreateOptions | undefined): string {
  return options?.id ?? (options?.newId ?? generateId)();
}

/** Creates an empty workspace with no projects and no environments. */
export function createWorkspace(name: string, options?: CreateOptions & { readonly now?: () => Date }): Workspace {
  const now = options?.now ?? (() => new Date());
  return {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    id: idOf(options),
    name,
    createdAt: now().toISOString(),
    properties: {},
    disabledProperties: [],
    projects: [],
    environments: [],
  };
}

/**
 * Creates a workspace environment: its `slug` is `uniqueSlug(name, taken)` (so
 * it never collides with an already-taken slug, case-insensitively) and its
 * `order` defaults to `taken.size` — i.e. it is appended after every
 * environment `taken` was built from.
 */
export function createWorkspaceEnvironment(
  name: string,
  taken: ReadonlySet<string>,
  options?: CreateOptions,
): WorkspaceEnvironment {
  return {
    id: idOf(options),
    name,
    slug: uniqueSlug(name, taken),
    order: options?.order ?? taken.size,
    properties: {},
    endpoints: {},
    disabledProperties: [],
  };
}
