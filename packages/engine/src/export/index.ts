/** Exporting a project, an API or an interface to a collection format (spec `2026-10-08-collection-exporters-design.md`). */

import type { CollectionExportFormat, CollectionExportInput, CollectionExportResult } from './model.js';
import { writePostman } from './postman.js';
import { ExportContext } from './shared.js';
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
 * The files of `input`'s target in `format`, and the report of what did not fit.
 *
 * @throws ExportError `export-target-not-found` or `export-nothing`
 */
export function exportCollection(format: CollectionExportFormat, input: CollectionExportInput): CollectionExportResult {
  const ctx = new ExportContext();
  const tree = buildTree(input, ctx);
  if (format !== 'postman') throw new Error(`The ${format} exporter is not built yet`);
  const written = writePostman(tree, ctx, input.newId ?? randomId);
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
