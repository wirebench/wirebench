/**
 * Format-version handling for workspace folders. Mirrors `project/migrate.ts`.
 *
 * `formatVersion` is bumped only on breaking changes. Opening a workspace
 * written by a newer Wirebench must fail loudly rather than silently dropping
 * the parts this build does not understand.
 */

import { WorkspaceError } from '../errors.js';
import { WORKSPACE_FORMAT_VERSION } from './model.js';

/** A raw manifest document, before schema validation. */
type RawWorkspaceManifest = Record<string, unknown>;

/**
 * Brings a raw manifest document up to {@link WORKSPACE_FORMAT_VERSION}.
 *
 * Version 1 is the initial format, so this is a no-op today; the function
 * exists so the call site (and its tests) are already in place when version 2
 * arrives.
 *
 * @throws WorkspaceError `workspace-format-too-new` when the file was written
 * by a newer Wirebench, `workspace-file-invalid` when the document is not a
 * mapping or `formatVersion` is missing, not a number, or below 1.
 */
export function migrateWorkspace(document: unknown, file: string): RawWorkspaceManifest {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new WorkspaceError('workspace-file-invalid', `Invalid workspace file ${file}: expected a YAML mapping`, {
      details: { file, issues: [{ path: '', message: 'expected a YAML mapping' }] },
    });
  }
  const raw = document as RawWorkspaceManifest;
  const version = raw['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new WorkspaceError('workspace-file-invalid', `Invalid workspace file ${file}: bad formatVersion`, {
      details: {
        file,
        issues: [{ path: 'formatVersion', message: `expected an integer >= 1, got ${JSON.stringify(version)}` }],
      },
    });
  }
  if (version > WORKSPACE_FORMAT_VERSION) {
    throw new WorkspaceError(
      'workspace-format-too-new',
      `Workspace was created by a newer version of Wirebench (format ${version}, this build supports ${WORKSPACE_FORMAT_VERSION})`,
      { details: { file, formatVersion: version, supported: WORKSPACE_FORMAT_VERSION } },
    );
  }
  return raw;
}
