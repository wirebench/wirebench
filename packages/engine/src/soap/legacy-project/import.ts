/**
 * Reading a legacy single-XML SOAP project from a file or text. Mapping it onto a Wirebench project
 * is `map.ts`'s job, once each interface's definition has been resolved.
 */

import { readFile, stat } from 'node:fs/promises';
import { LegacyProjectError } from '../../errors.js';
import type { LegacyProject } from './model.js';
import { parseLegacyProject } from './parse.js';

/** Where a legacy project comes from: a file on disk or text already held in memory. */
export type LegacyProjectSource =
  { readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string };

/** Largest project accepted, in bytes (file) or UTF-16 code units (text). */
export const MAX_LEGACY_PROJECT_BYTES = 50 * 1024 * 1024;

function tooLarge(): LegacyProjectError {
  return new LegacyProjectError(
    'legacy-too-large',
    `The project file is larger than ${String(MAX_LEGACY_PROJECT_BYTES / (1024 * 1024))} MB`,
  );
}

/**
 * Reads and parses a legacy SOAP project.
 *
 * @throws LegacyProjectError when the file cannot be read, is too large, or is not a readable project.
 */
export async function readLegacySoapProject(source: LegacyProjectSource): Promise<LegacyProject> {
  if (source.kind === 'text') {
    if (source.text.length > MAX_LEGACY_PROJECT_BYTES) {
      throw tooLarge();
    }
    return parseLegacyProject(source.text);
  }
  let size: number | undefined;
  try {
    size = (await stat(source.path)).size;
  } catch {
    size = undefined; // reported by readFile below
  }
  if (size !== undefined && size > MAX_LEGACY_PROJECT_BYTES) {
    throw tooLarge();
  }
  let text: string;
  try {
    text = await readFile(source.path, 'utf8');
  } catch (cause) {
    throw new LegacyProjectError('legacy-read-failed', `Could not read "${source.path}"`, {
      cause,
      details: { path: source.path },
    });
  }
  return parseLegacyProject(text, source.path);
}
