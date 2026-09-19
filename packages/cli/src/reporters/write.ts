import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { UsageError } from '../args.js';

/**
 * Writes a report file, creating its directory first. The path is whatever the caller resolved
 * it to (against the process's working directory, never the project) — this module only writes.
 * Any failure — the parent is a regular file, permissions, a bad path — becomes a `UsageError` so
 * the CLI exits 2, per the spec's "a report that cannot be written is exit 2".
 */
export async function writeReport(file: string, content: string): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Cannot write the report to ${file}: ${reason}`);
  }
}
