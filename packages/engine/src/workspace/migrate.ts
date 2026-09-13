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
 * The result of bringing a raw manifest document up to {@link WORKSPACE_FORMAT_VERSION}: the
 * migrated manifest itself, plus anything the migration pulled *out* of it because it no longer
 * belongs there — today, a v1/v2 `activeEnvironmentId`, which `load.ts` hands to the caller so it
 * can be adopted into `local.yaml` (see `local-state.ts`) rather than silently dropped.
 */
export interface MigratedWorkspaceManifest {
  readonly manifest: RawWorkspaceManifest;
  readonly legacy: { readonly activeEnvironmentId?: string };
}

/**
 * Brings a raw manifest document up to {@link WORKSPACE_FORMAT_VERSION}.
 *
 * Version 1 needs no rewrite of its own beyond what version 2 does: it simply has no `disabled`
 * key, and `load.ts` defaults a missing list to empty. Versions 1 and 2 both carried
 * `activeEnvironmentId` (machine-local, moved to `local.yaml` in v3) and `writtenBy` (dropped
 * outright — see `model.ts`); this function lifts the former into {@link MigratedWorkspaceManifest.legacy}
 * and drops both from the manifest, then stamps the document with the current `formatVersion` so
 * schema validation (which pins `formatVersion` to a literal) accepts a document written by an
 * older build. The next save then writes the file back at the current version.
 *
 * @throws WorkspaceError `workspace-format-too-new` when the file was written
 * by a newer Wirebench, `workspace-file-invalid` when the document is not a
 * mapping or `formatVersion` is missing, not a number, or below 1.
 */
export function migrateWorkspace(document: unknown, file: string): MigratedWorkspaceManifest {
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

  const activeEnvironmentId = raw['activeEnvironmentId'];
  const legacy = version < 3 && typeof activeEnvironmentId === 'string' ? { activeEnvironmentId } : {};
  const rest = { ...raw };
  delete rest['activeEnvironmentId'];
  delete rest['writtenBy'];
  return { manifest: { ...rest, formatVersion: WORKSPACE_FORMAT_VERSION }, legacy };
}
