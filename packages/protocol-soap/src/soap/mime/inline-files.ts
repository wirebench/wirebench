/**
 * "Enable Inline Files": an element whose text is exactly `file:<path>` has that
 * file's bytes substituted, base64-encoded, at send time.
 *
 * The decision is syntactic, not schema-driven, so a
 * request can carry a file reference before its schema is even known. A reference that
 * cannot be read is reported and left verbatim in the envelope rather than failing the
 * send: the server's own error is usually more informative than a client-side abort.
 */

import { isAbsolute, join } from 'node:path';
import { scanXml } from '../../xsd/xml-scan.js';
import { forEachScannedElement, spliceRanges } from './cid-scan.js';

/** Knobs for {@link inlineFiles}. */
export interface InlineFilesOptions {
  /** The request's "Enable Inline Files" property; nothing happens when false. */
  readonly enabled: boolean;
  /** Reads one file, rejecting when it does not exist. */
  readonly resolveFile: (path: string) => Promise<Uint8Array>;
  /** Project resource root; relative references are tried against it first. */
  readonly resourceRoot?: string;
}

/** A file reference that could not be read. */
export interface InlineFileProblem {
  readonly code: 'inline-file-missing';
  readonly message: string;
  /** The path as written in the envelope. */
  readonly path: string;
}

/** What {@link inlineFiles} produced. */
export interface InlinedFiles {
  readonly envelopeXml: string;
  /** How many references were replaced. */
  readonly inlined: number;
  readonly problems: readonly InlineFileProblem[];
}

const FILE_TEXT = /^file:(.+)$/;

/** The paths a reference may resolve to, most specific first. */
function candidatePaths(reference: string, resourceRoot: string | undefined): readonly string[] {
  const path = reference.startsWith('//') ? reference.slice(2) : reference;
  if (isAbsolute(path) || resourceRoot === undefined) {
    return [path];
  }
  return [join(resourceRoot, path), path];
}

/**
 * Replaces every `file:` reference in `envelopeXml` with the base64 of the file it names.
 *
 * @param envelopeXml the envelope to rewrite
 * @param options whether the feature is on, how to read a file, and the resource root
 */
export async function inlineFiles(envelopeXml: string, options: InlineFilesOptions): Promise<InlinedFiles> {
  if (!options.enabled) {
    return { envelopeXml, inlined: 0, problems: [] };
  }
  const scan = scanXml(envelopeXml);
  if (scan.problems.length > 0) {
    return { envelopeXml, inlined: 0, problems: [] };
  }

  const references: { readonly path: string; readonly range: { readonly start: number; readonly end: number } }[] = [];
  forEachScannedElement(scan.elements, (element) => {
    const text = element.text;
    if (text === undefined) {
      return;
    }
    const match = FILE_TEXT.exec(text.value.trim());
    if (match?.[1] !== undefined) {
      references.push({ path: match[1], range: text.range });
    }
  });

  const edits: { readonly range: { readonly start: number; readonly end: number }; readonly text: string }[] = [];
  const problems: InlineFileProblem[] = [];
  for (const reference of references) {
    let bytes: Uint8Array | undefined;
    for (const candidate of candidatePaths(reference.path, options.resourceRoot)) {
      try {
        bytes = await options.resolveFile(candidate);
        break;
      } catch {
        bytes = undefined;
      }
    }
    if (bytes === undefined) {
      problems.push({
        code: 'inline-file-missing',
        message: `Inline file "${reference.path}" could not be read; the reference was left in the request`,
        path: reference.path,
      });
      continue;
    }
    edits.push({ range: reference.range, text: Buffer.from(bytes).toString('base64') });
  }

  return { envelopeXml: spliceRanges(envelopeXml, edits), inlined: edits.length, problems };
}
