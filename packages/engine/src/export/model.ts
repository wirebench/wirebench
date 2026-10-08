/**
 * What an export takes and hands back (spec `2026-10-08-collection-exporters-design.md` §3): a
 * project in, the files' text and a report out. The host names the folder and writes the files.
 */

import type { ImportReport } from '../import/report.js';
import type { Project, PropertyMap } from '../project/model.js';

export type CollectionExportFormat = 'postman' | 'opencollection';

export const COLLECTION_EXPORT_FORMATS: readonly CollectionExportFormat[] = ['postman', 'opencollection'];

/** One environment to write, the workspace's or the project's. */
export interface CollectionExportEnvironment {
  readonly name: string;
  readonly properties: PropertyMap;
  readonly disabledProperties: readonly string[];
  /** SOAP endpoint overrides, which neither format holds; reported when present. */
  readonly endpoints?: Readonly<Record<string, string>>;
}

export type CollectionExportTarget = { readonly kind: 'project' } | { readonly kind: 'container'; readonly id: string };

export interface CollectionExportInput {
  readonly project: Project;
  /** The whole project, or one REST, gRPC or WebSocket API or SOAP interface by id. */
  readonly target: CollectionExportTarget;
  /** Properties the host adds below the project's own (the workspace's). Default: none. */
  readonly workspaceProperties?: PropertyMap;
  /** Names of {@link workspaceProperties} switched off. */
  readonly workspaceDisabledProperties?: readonly string[];
  /** Environments to write. Default: the project's own. */
  readonly environments?: readonly CollectionExportEnvironment[];
  /** Ids written into the files (a collection's `_postman_id`). Default: random UUIDs. */
  readonly newId?: () => string;
}

export interface CollectionExportFile {
  /** A bare file name: no folder, no `..`; the host joins it under the folder the user picked. */
  readonly name: string;
  readonly text: string;
}

export interface CollectionExportResult {
  readonly files: readonly CollectionExportFile[];
  readonly counts: { readonly requests: number; readonly folders: number; readonly environments: number };
  /** `warnings`: what was lost. `notes`: what was changed to fit. */
  readonly report: ImportReport;
}
