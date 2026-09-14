/**
 * Derives on-disk file names for the documents in a {@link DefinitionBundle}
 * when writing a definition cache or an export folder. Shared by
 * `wsdl/cache.ts` and `wsdl/export-definition.ts` so both lay documents out
 * identically (a location always maps to the same relative file name).
 *
 * File names are sanitised with the same segment-validation rules Task 17
 * uses for project slugs ({@link sanitiseFileName}/{@link isReservedFileName}
 * from `project/paths.ts`), so a hyphen or space is preserved and a Windows
 * reserved device name (`CON`, `NUL`, `COM1`, ...) is renamed safely instead
 * of being written as-is.
 */

import { isReservedFileName, sanitiseFileName } from '../project/paths.js';

/** Extracts the last path segment of a location's pathname, ignoring any query/fragment. */
function lastPathSegment(location: string): string | undefined {
  try {
    const url = new URL(location);
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    return segments.at(-1);
  } catch {
    return undefined;
  }
}

/** The least a document must say for a file name to be derived from it. */
export interface NameableDocument {
  readonly location: string;
  /** The extension a document with no usable name of its own falls back to (`wsdl`, `xsd`, `yaml`). */
  readonly kind: string;
}

/** Options accepted by {@link assignFileNames}. */
export interface AssignFileNamesOptions {
  /** File name for the root document when its location gives none. Defaults to `service.wsdl`. */
  readonly rootFile?: string;
}

/** Extension to use for a document with no usable name of its own, keyed by `kind`. */
function fallbackName(isRoot: boolean, kind: string, index: number, rootFile: string): string {
  if (isRoot) {
    return rootFile;
  }
  return `document-${index}.${kind}`;
}

/**
 * Renames a reserved Windows device name (`CON`, `NUL`, `COM1`, ...) safely
 * by suffixing its stem with `_`, keeping the extension intact (`con.xsd` →
 * `con_.xsd`). Names that are not reserved pass through unchanged.
 */
function guardReservedName(name: string): string {
  if (!isReservedFileName(name)) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${stem}_${ext}`;
}

/**
 * Chooses a base file name for one document: the last segment of its
 * location when it looks like a real file name (has an extension), or a
 * `service.wsdl` / `document-N.<kind>` fallback for extensionless or
 * unparsable locations (e.g. a `?wsdl` query-string root). Either way, the
 * result is sanitised and guarded against Windows reserved device names.
 */
function baseFileName(doc: NameableDocument, isRoot: boolean, index: number, rootFile: string): string {
  const segment = lastPathSegment(doc.location);
  if (segment !== undefined && /\.[A-Za-z0-9]+$/.test(segment)) {
    return guardReservedName(sanitiseFileName(segment));
  }
  return guardReservedName(fallbackName(isRoot, doc.kind, index, rootFile));
}

/** One document's assigned on-disk file name, alongside the document itself. */
export interface NamedDocument<T extends NameableDocument = NameableDocument> {
  readonly document: T;
  readonly file: string;
}

/**
 * Assigns a unique, sanitised file name to every document in `documents`
 * (root first, in the order given), de-duplicating collisions with a
 * numeric suffix inserted before the extension (`service.wsdl`,
 * `service-2.wsdl`, ...).
 *
 * Generic in the document type so a caller keeps its own: the naming rules
 * only ever read `location` and `kind`, which is why an OpenAPI definition
 * cache uses the same function as a WSDL one.
 */
export function assignFileNames<T extends NameableDocument>(
  documents: readonly T[],
  options?: AssignFileNamesOptions,
): readonly NamedDocument<T>[] {
  const rootFile = options?.rootFile ?? 'service.wsdl';
  const used = new Set<string>();
  const named: NamedDocument<T>[] = [];

  documents.forEach((document, index) => {
    const isRoot = index === 0;
    const base = baseFileName(document, isRoot, index, rootFile);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';

    let candidate = base;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${stem}-${n}${ext}`;
      n += 1;
    }
    used.add(candidate.toLowerCase());
    named.push({ document, file: candidate });
  });

  return named;
}
