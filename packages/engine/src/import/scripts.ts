/**
 * Scripts an importer keeps as text (spec §7.4, §6.2): written under `imported-scripts/` by the
 * desktop main process, never read back or run. The path rule here is pure.
 */
/** The folder imported scripts are written to. Nothing in Wirebench reads it. */
export const IMPORTED_SCRIPTS_DIR = 'imported-scripts';

export interface ImportedScriptFile {
  readonly path: string;
  readonly source: string;
}

/** `imported-scripts/<api>/<item>.<tail>`, with `-2`, `-3` before the tail for a repeat. */
export function importedScriptPath(apiSlug: string, itemSlug: string, fileTail: string, taken: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const item = n === 1 ? itemSlug : `${itemSlug}-${n}`;
    const path = `${IMPORTED_SCRIPTS_DIR}/${apiSlug}/${item}.${fileTail}`;
    if (!taken.has(path)) {
      taken.add(path);
      return path;
    }
  }
}
