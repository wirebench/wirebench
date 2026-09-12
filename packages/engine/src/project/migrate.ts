/**
 * Format-version handling for project folders.
 *
 * `formatVersion` is bumped only on breaking changes. Opening a project written
 * by a newer Wirebench must fail loudly rather than silently dropping the parts
 * this build does not understand.
 */

import { ProjectError } from '../errors.js';
import { FORMAT_VERSION } from './model.js';

/** A raw manifest document, before schema validation. */
type RawManifest = Record<string, unknown>;

/**
 * Brings a raw manifest document up to {@link FORMAT_VERSION}.
 *
 * Version 1 needs no rewrite of its own: it simply has no `disabled` key, and
 * `load.ts` defaults a missing list to empty. This function's job is narrower
 * — validate the version is in `[1, FORMAT_VERSION]` and stamp the document
 * with the current `formatVersion` so schema validation (which pins
 * `formatVersion` to a literal) accepts a document written by an older build.
 * The next save then writes the file back at the current version.
 *
 * @throws ProjectError `project-format-too-new` when the file was written by a
 * newer Wirebench, `project-file-invalid` when `formatVersion` is missing,
 * not a number, or below 1.
 */
export function migrate(document: unknown, file: string): RawManifest {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new ProjectError('project-file-invalid', `Invalid project file ${file}: expected a YAML mapping`, {
      details: { file, issues: [{ path: '', message: 'expected a YAML mapping' }] },
    });
  }
  const raw = document as RawManifest;
  const version = raw['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ProjectError('project-file-invalid', `Invalid project file ${file}: bad formatVersion`, {
      details: {
        file,
        issues: [{ path: 'formatVersion', message: `expected an integer >= 1, got ${JSON.stringify(version)}` }],
      },
    });
  }
  if (version > FORMAT_VERSION) {
    throw new ProjectError(
      'project-format-too-new',
      `Project was created by a newer version of Wirebench (format ${version}, this build supports ${FORMAT_VERSION})`,
      { details: { file, formatVersion: version, supported: FORMAT_VERSION } },
    );
  }
  return { ...raw, formatVersion: FORMAT_VERSION };
}
