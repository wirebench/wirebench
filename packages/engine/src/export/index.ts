/** Exporting a project, an API or an interface to a collection format (spec `2026-10-08-collection-exporters-design.md`). */

import type { CollectionExportFormat, CollectionExportInput, CollectionExportResult } from './model.js';
import { writeOpenCollection } from './opencollection.js';
import { writePostman } from './postman.js';
import { ExportContext } from './shared.js';
import type { ScriptApi } from '#core/script/model';
import { buildTree } from './tree.js';

export type {
  CollectionExportFile,
  CollectionExportEnvironment,
  CollectionExportFormat,
  CollectionExportInput,
  CollectionExportResult,
  CollectionExportTarget,
} from './model.js';
export { COLLECTION_EXPORT_FORMATS } from './model.js';

const randomId = (): string => globalThis.crypto.randomUUID();

/**
 * The script API each format's tool runs. An Insomnia script is Postman-shaped but calls `insomnia`
 * and `$`, which Postman does not define, so a Postman export warns about it like any other.
 */
const TARGET_SCRIPT_API: Record<CollectionExportFormat, ScriptApi> = {
  postman: 'postman',
  opencollection: 'bruno',
};

/**
 * The files of `input`'s target in `format`, and the report of what did not fit.
 *
 * @throws ExportError `export-target-not-found` or `export-nothing`
 */
export function exportCollection(format: CollectionExportFormat, input: CollectionExportInput): CollectionExportResult {
  const ctx = new ExportContext();
  const tree = buildTree(input, ctx, TARGET_SCRIPT_API[format]);
  const written =
    format === 'postman' ? writePostman(tree, ctx, input.newId ?? randomId) : writeOpenCollection(tree, ctx);
  return {
    files: written.files,
    counts: {
      requests: written.requests,
      folders: written.folders,
      environments: tree.environments.length,
    },
    report: ctx.report.build(),
  };
}
