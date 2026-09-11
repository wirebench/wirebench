/**
 * Writes an entire resolved definition (the root WSDL and every document it
 * imports/includes) to a plain folder — "Export Definition": the
 * folder is self-contained and portable, with every cross-document reference
 * rewritten to a relative file name so the exported set opens standalone.
 *
 * Unlike `wsdl/cache.ts`, documents ARE re-serialised here (the rewritten
 * reference has to land somewhere), and no manifest is written.
 */

import { join } from 'node:path';
import type { Element } from '@xmldom/xmldom';
import { nodeFs } from '../project/fs.js';
import { writeFileAtomic } from '../project/fs.js';
import type { FsLike } from '../project/fs.js';
import { NS } from '../xml/namespaces.js';
import { parseXml } from '../xml/parse.js';
import { serializeXml } from '../xml/serialize.js';
import { assignFileNames } from './cache-naming.js';
import { childElements, firstChildElement, optionalAttribute } from './dom-utils.js';
import type { BundledDocument, DefinitionBundle } from './resolver.js';

/** Options accepted by {@link exportDefinition}. */
export interface ExportDefinitionOptions {
  /** Overrides the file system, e.g. for tests. Defaults to `nodeFs`. */
  readonly fs?: FsLike;
}

/** One document written by {@link exportDefinition}. */
export interface ExportedFile {
  /** File name written inside the target directory. */
  readonly file: string;
  /** The document's canonical location in the original bundle. */
  readonly location: string;
}

/** The result of {@link exportDefinition}. */
export interface ExportResult {
  readonly files: readonly ExportedFile[];
}

/** Resolves `ref` (an import/include/redefine location) against `base` using the WHATWG `URL` class. */
function resolveUrl(ref: string, base: string): string {
  return new URL(ref, base).toString();
}

/**
 * Rewrites one `location`/`schemaLocation` attribute on `element` to the
 * exported file name of the document it points to, when that document is
 * part of the bundle. References to a document the bundle never resolved
 * (a namespace-only import, or one that failed to fetch) are left as-is.
 */
function rewriteReference(
  element: Element,
  attrName: string,
  ownerLocation: string,
  fileByLocation: ReadonlyMap<string, string>,
): void {
  const ref = optionalAttribute(element, attrName);
  if (ref === undefined) {
    return;
  }
  const absolute = resolveUrl(ref, ownerLocation);
  const file = fileByLocation.get(absolute);
  if (file !== undefined) {
    element.setAttribute(attrName, file);
  }
}

/** Rewrites the `xs:import`/`xs:include`/`xs:redefine` children of one `xs:schema` element. */
function rewriteSchemaReferences(
  schemaEl: Element,
  ownerLocation: string,
  fileByLocation: ReadonlyMap<string, string>,
): void {
  for (const el of childElements(schemaEl, NS.XSD, 'import')) {
    rewriteReference(el, 'schemaLocation', ownerLocation, fileByLocation);
  }
  for (const el of childElements(schemaEl, NS.XSD, 'include')) {
    rewriteReference(el, 'schemaLocation', ownerLocation, fileByLocation);
  }
  for (const el of childElements(schemaEl, NS.XSD, 'redefine')) {
    rewriteReference(el, 'schemaLocation', ownerLocation, fileByLocation);
  }
}

/**
 * Rewrites every cross-document reference inside `root` (the document
 * element of a freshly re-parsed copy of `doc` — never the DOM node owned by
 * the original bundle, which callers may still hold onto), in place.
 */
function rewriteDocumentReferences(
  root: Element,
  doc: Pick<BundledDocument, 'kind' | 'location'>,
  fileByLocation: ReadonlyMap<string, string>,
): void {
  if (doc.kind === 'wsdl') {
    for (const el of childElements(root, NS.WSDL, 'import')) {
      rewriteReference(el, 'location', doc.location, fileByLocation);
    }
    const typesEl = firstChildElement(root, NS.WSDL, 'types');
    if (typesEl !== undefined) {
      for (const schemaEl of childElements(typesEl, NS.XSD, 'schema')) {
        rewriteSchemaReferences(schemaEl, doc.location, fileByLocation);
      }
    }
  } else {
    rewriteSchemaReferences(root, doc.location, fileByLocation);
  }
}

/**
 * Writes every document of `bundle` to `targetDir` (created if needed), with
 * every `wsdl:import/@location`, `xs:import/@schemaLocation`,
 * `xs:include/@schemaLocation` and `xs:redefine/@schemaLocation` rewritten to
 * the relative file name of the referenced document, so the folder is
 * self-contained and can be re-imported standalone.
 *
 * @param bundle the resolved definition to export
 * @param targetDir absolute path of the destination folder
 */
export async function exportDefinition(
  bundle: DefinitionBundle,
  targetDir: string,
  options?: ExportDefinitionOptions,
): Promise<ExportResult> {
  const fs = options?.fs ?? nodeFs;
  const named = assignFileNames(bundle.documents);
  const fileByLocation = new Map(named.map(({ document, file }) => [document.location, file]));

  const files: ExportedFile[] = [];
  for (const { document, file } of named) {
    // Re-parse rather than mutate `document.document` in place: that DOM node is owned by
    // the caller's bundle, which may still be in use (e.g. for the schema set) after export.
    const working = parseXml(document.text, { location: document.location });
    const root = working.documentElement;
    if (root !== null) {
      rewriteDocumentReferences(root, document, fileByLocation);
    }
    const xml = serializeXml(working);
    await writeFileAtomic(fs, join(targetDir, file), xml);
    files.push({ file, location: document.location });
  }

  return { files };
}
