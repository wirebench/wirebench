/**
 * Reads every file under `sequences/`, for loading a project and for deciding what a save may delete.
 *
 * The two questions share one answer on purpose. A save deletes the managed files the project no
 * longer has; if "managed" meant every `*.sequence.yaml`, a file this build refused to load (written by
 * a newer build, malformed mid-merge, or a copy with a duplicate id) would vanish on the next save
 * without the user ever seeing it. So a file is managed only when this build loaded it.
 */

import { join } from 'node:path';
import { isWirebenchError } from '../errors.js';
import { readFileIfExists, readdirIfExists } from '../project/fs.js';
import type { FsLike } from '../project/fs.js';
import { SEQUENCES_DIR, parseSequenceFile, sequenceSlugOf } from './file.js';
import type { Sequence } from './model.js';

/** A sequence file that did not load, and why. */
export interface SequenceFileProblem {
  readonly code: 'sequence-file-invalid' | 'sequence-version-too-new' | 'sequence-duplicate-id';
  readonly message: string;
  /** Path relative to the project root. */
  readonly file: string;
}

/** What {@link readSequences} found. */
export interface SequenceFiles {
  /** Sequences that loaded, each with the file it came from. */
  readonly loaded: readonly { readonly file: string; readonly sequence: Sequence }[];
  readonly problems: readonly SequenceFileProblem[];
}

/**
 * Reads and parses every `sequences/*.sequence.yaml`. Never throws for a bad file: each becomes a
 * problem and is left out. When two files share an id, the first by file name loads and the others are
 * `sequence-duplicate-id` problems, so which one wins does not depend on the order the OS lists them.
 */
export async function readSequences(fs: FsLike, root: string): Promise<SequenceFiles> {
  const entries = [...(await readdirIfExists(fs, join(root, SEQUENCES_DIR)))]
    .filter((entry) => entry.isFile && sequenceSlugOf(entry.name) !== undefined)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const loaded: { file: string; sequence: Sequence }[] = [];
  const problems: SequenceFileProblem[] = [];
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const file = `${SEQUENCES_DIR}/${entry.name}`;
    const bytes = await readFileIfExists(fs, join(root, SEQUENCES_DIR, entry.name));
    if (bytes === undefined) {
      continue;
    }
    let sequence: Sequence;
    try {
      sequence = parseSequenceFile(bytes, file, sequenceSlugOf(entry.name) ?? entry.name);
    } catch (error) {
      if (
        isWirebenchError(error) &&
        (error.code === 'sequence-file-invalid' || error.code === 'sequence-version-too-new')
      ) {
        problems.push({ code: error.code, message: error.message, file });
        continue;
      }
      throw error;
    }
    const first = seen.get(sequence.id);
    if (first !== undefined) {
      problems.push({
        code: 'sequence-duplicate-id',
        message: `${file} has the same id as ${first}; it was not loaded and is left as it is`,
        file,
      });
      continue;
    }
    seen.set(sequence.id, file);
    loaded.push({ file, sequence });
  }
  return { loaded, problems };
}
