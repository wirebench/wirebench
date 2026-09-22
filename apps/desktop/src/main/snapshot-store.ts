/**
 * Reads and writes a request's golden response: a `<slug>.golden.yaml` sidecar in the request's
 * own folder. The sidecar lives outside the project model, so saving the project never touches it
 * and no format bump is needed; the body is a YAML block scalar so a golden diffs well in git.
 */

import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, parse as parseYamlText } from 'yaml';
import { requestFileLocation, WirebenchError } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { snapshotSchema } from '../shared/wire-types.js';
import type { SnapshotReadResponse, SnapshotWire } from '../shared/wire-types.js';
import { isInsideReal, realpathOfPrefix } from './path-containment.js';

/** The saved project that holds a request: its model and the folder it was saved to. */
export interface SavedProjectRef {
  readonly project: Project;
  readonly dir: string;
}

/** Finds the saved project holding `requestId`, or `undefined` when there is none. */
export type SavedProjectLookup = (requestId: string) => SavedProjectRef | undefined;

/** Where a request's sidecar goes, once containment and the request file have been checked. */
interface SidecarPath {
  readonly file: string;
}

export class SnapshotStore {
  constructor(private readonly lookup: SavedProjectLookup) {}

  async read({ requestId }: { requestId: string }): Promise<SnapshotReadResponse> {
    const sidecar = await this.locate(requestId);
    if (sidecar === undefined) {
      return { status: 'unsaved' };
    }
    const snapshot = await readSidecar(sidecar.file);
    return snapshot === undefined ? { status: 'none' } : { status: 'present', snapshot };
  }

  async write(input: {
    requestId: string;
    body: string;
    contentType?: string | undefined;
    ignore: readonly string[];
  }): Promise<{ savedAt: string }> {
    const sidecar = await this.require(input.requestId);
    const savedAt = new Date().toISOString();
    await writeSidecar(sidecar.file, {
      ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
      savedAt,
      ignore: [...input.ignore],
      body: input.body,
    });
    return { savedAt };
  }

  async setIgnore({
    requestId,
    ignore,
  }: {
    requestId: string;
    ignore: readonly string[];
  }): Promise<{ savedAt: string }> {
    const sidecar = await this.require(requestId);
    const current = await readSidecar(sidecar.file);
    if (current === undefined) {
      throw new WirebenchError('snapshot-missing', 'No snapshot is saved for this request', { details: { requestId } });
    }
    // `savedAt` records when the body was captured; changing the ignore rules does not recapture it.
    await writeSidecar(sidecar.file, { ...current, ignore: [...ignore] });
    return { savedAt: current.savedAt };
  }

  async remove({ requestId }: { requestId: string }): Promise<{ removed: boolean }> {
    const sidecar = await this.locate(requestId);
    if (sidecar === undefined || !existsSync(sidecar.file)) {
      return { removed: false };
    }
    await rm(sidecar.file, { force: true });
    return { removed: true };
  }

  private async require(requestId: string): Promise<SidecarPath> {
    const sidecar = await this.locate(requestId);
    if (sidecar === undefined) {
      throw new WirebenchError('snapshot-unsaved', 'Save the project to keep a snapshot beside this request', {
        details: { requestId },
      });
    }
    return sidecar;
  }

  /**
   * The sidecar path for `requestId`, or `undefined` when the request is not in a saved project,
   * its `*.request.yaml` is not on disk, or the path would leave the project folder (slugs come
   * from the model and are not trusted here).
   */
  private async locate(requestId: string): Promise<SidecarPath | undefined> {
    const saved = this.lookup(requestId);
    if (saved === undefined) {
      return undefined;
    }
    const location = requestFileLocation(saved.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const folder = join(saved.dir, ...location.dir.split('/'));
    const requestFile = join(folder, `${location.slug}.request.yaml`);
    const file = join(folder, `${location.slug}.golden.yaml`);
    const root = await realpathOfPrefix(saved.dir);
    const [requestReal, fileReal] = await Promise.all([realpathOfPrefix(requestFile), realpathOfPrefix(file)]);
    if (!isInsideReal(root, requestReal) || !isInsideReal(root, fileReal) || !existsSync(requestFile)) {
      return undefined;
    }
    return { file: fileReal };
  }
}

/** The sidecar at `file`, or `undefined` when there is none or it is malformed (with a warning). */
async function readSidecar(file: string): Promise<SnapshotWire | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = snapshotSchema.safeParse(parseYamlText(text));
    if (parsed.success) {
      return parsed.data;
    }
    console.warn('[snapshot] ignoring a malformed snapshot file', file, parsed.error.message);
  } catch (error) {
    console.warn(
      '[snapshot] ignoring a malformed snapshot file',
      file,
      error instanceof Error ? error.message : String(error),
    );
  }
  return undefined;
}

/** Writes `snapshot` to `file` atomically (temp file, then rename), the body as a block scalar. */
async function writeSidecar(file: string, snapshot: SnapshotWire): Promise<void> {
  const doc = new Document(snapshot, { sortMapEntries: true });
  const body = doc.get('body', true) as { type?: string } | undefined;
  if (body !== undefined) {
    body.type = 'BLOCK_LITERAL';
  }
  const text = doc.toString({ lineWidth: 0 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
