/**
 * Reads and writes a request's golden response: a `<slug>.golden.yaml` sidecar in the request's
 * own folder. The sidecar lives outside the project model, so saving the project never touches it
 * and no format bump is needed; the body is a YAML block scalar so a golden diffs well in git
 * (double-quoted only when a block scalar would not read back the same).
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Document, parse as parseYamlText } from 'yaml';
import { readGoldenFile, requestFileLocation, WirebenchError } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import type { SnapshotReadResponse, SnapshotWire } from '../shared/wire-types.js';
import { isInsideReal, realpathOfPrefix } from './path-containment.js';

/** The saved project that holds a request: its model and the folder it was saved to. */
export interface SavedProjectRef {
  readonly project: Project;
  readonly dir: string;
}

/** Finds the saved project holding `requestId`, or `undefined` when there is none. */
export type SavedProjectLookup = (requestId: string) => SavedProjectRef | undefined;

/**
 * Where a request's sidecar goes, once containment and the request file have been checked, and
 * what is at that path now: nothing, a regular file, or something else (a symlink, a folder).
 */
interface SidecarPath {
  readonly file: string;
  readonly kind: 'missing' | 'file' | 'other';
}

export class SnapshotStore {
  /**
   * The tail of each request's chain of mutations. `write`, `setIgnore` and `remove` each read
   * and then replace the sidecar, so two of them for one request run one after the other, in the
   * order they were issued, and the last call issued is the one left on disk.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly lookup: SavedProjectLookup) {}

  async read({ requestId }: { requestId: string }): Promise<SnapshotReadResponse> {
    const saved = this.lookup(requestId);
    // `locate` is the store's "unsaved" test: no saved project, no file location, an escaped folder,
    // or no `*.request.yaml` yet.
    if (saved === undefined || (await this.locate(requestId)) === undefined) {
      return { status: 'unsaved' };
    }
    const read = await readGoldenFile(saved.dir, saved.project, requestId);
    if (read.status === 'present') {
      return { status: 'present', snapshot: { ...read.golden, ignore: [...read.golden.ignore] } };
    }
    if (read.status === 'unreadable') {
      console.warn('[snapshot] ignoring an unreadable snapshot file', requestId, read.reason);
    }
    return { status: 'none' };
  }

  write(input: {
    requestId: string;
    body: string;
    contentType?: string | undefined;
    ignore: readonly string[];
  }): Promise<{ savedAt: string }> {
    return this.serial(input.requestId, async () => {
      const sidecar = await this.require(input.requestId);
      const savedAt = new Date().toISOString();
      await writeSidecar(sidecar.file, {
        ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
        savedAt,
        ignore: [...input.ignore],
        body: input.body,
      });
      return { savedAt };
    });
  }

  setIgnore({ requestId, ignore }: { requestId: string; ignore: readonly string[] }): Promise<{ savedAt: string }> {
    return this.serial(requestId, async () => {
      const sidecar = await this.require(requestId);
      const saved = this.lookup(requestId);
      const read = saved === undefined ? undefined : await readGoldenFile(saved.dir, saved.project, requestId);
      if (read?.status !== 'present') {
        throw new WirebenchError('snapshot-missing', 'No snapshot is saved for this request', {
          details: { requestId },
        });
      }
      const current = read.golden;
      // `savedAt` records when the body was captured; changing the ignore rules does not recapture it.
      await writeSidecar(sidecar.file, { ...current, ignore: [...ignore] });
      return { savedAt: current.savedAt };
    });
  }

  remove({ requestId }: { requestId: string }): Promise<{ removed: boolean }> {
    return this.serial(requestId, async () => {
      const sidecar = await this.locate(requestId);
      if (sidecar === undefined || sidecar.kind === 'missing') {
        return { removed: false };
      }
      refuseNonFile(requestId, sidecar);
      await rm(sidecar.file, { force: true });
      return { removed: true };
    });
  }

  /** Runs `run` once every earlier mutation queued for `requestId` has settled, failed or not. */
  private serial<T>(requestId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(requestId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    this.queues.set(requestId, tail);
    void tail.then(() => {
      if (this.queues.get(requestId) === tail) {
        this.queues.delete(requestId);
      }
    });
    return next;
  }

  /** The sidecar to write, refusing an unsaved request and a path that is not a regular file. */
  private async require(requestId: string): Promise<SidecarPath> {
    const sidecar = await this.locate(requestId);
    if (sidecar === undefined) {
      throw new WirebenchError('snapshot-unsaved', 'Save the project to keep a snapshot beside this request', {
        details: { requestId },
      });
    }
    refuseNonFile(requestId, sidecar);
    return sidecar;
  }

  /**
   * The sidecar path for `requestId`, or `undefined` when the request is not in a saved project,
   * its `*.request.yaml` is not on disk, or the path would leave the project folder (slugs come
   * from the model and are not trusted here).
   *
   * Only the folder is resolved through symlinks; the sidecar's own name is joined on literally
   * and checked with `lstat`, so a `<slug>.golden.yaml` symlinked at another file in the project
   * is reported as `other` rather than followed to — and overwritten or deleted at — its target.
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
    const [requestReal, parentReal] = await Promise.all([
      realpathOfPrefix(requestFile),
      realpathOfPrefix(dirname(file)),
    ]);
    if (!isInsideReal(root, requestReal) || !isInsideReal(root, parentReal) || !existsSync(requestFile)) {
      return undefined;
    }
    const sidecar = join(parentReal, basename(file));
    return { file: sidecar, kind: await kindOf(sidecar) };
  }
}

/** What `lstat` finds at `file`, without following a symlink. */
async function kindOf(file: string): Promise<SidecarPath['kind']> {
  try {
    return (await lstat(file)).isFile() ? 'file' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

/** Refuses to replace or delete a sidecar path that holds a symlink, a folder or anything but a file. */
function refuseNonFile(requestId: string, sidecar: SidecarPath): void {
  if (sidecar.kind === 'other') {
    throw new WirebenchError('snapshot-not-a-file', 'The snapshot file for this request is not a regular file', {
      details: { requestId },
    });
  }
}

/**
 * `snapshot` as sidecar text, the body as a block scalar. A block scalar cannot hold every string
 * — a whitespace-only body such as `"  \n"` reads back differently — so the text is parsed back,
 * and a body that does not survive is written double-quoted instead, which holds any string.
 */
function sidecarText(snapshot: SnapshotWire): string {
  const doc = new Document(snapshot, { sortMapEntries: true });
  const body = doc.get('body', true) as { type?: string } | undefined;
  if (body === undefined) {
    return doc.toString({ lineWidth: 0 });
  }
  body.type = 'BLOCK_LITERAL';
  const text = doc.toString({ lineWidth: 0 });
  if ((parseYamlText(text) as { body?: unknown }).body === snapshot.body) {
    return text;
  }
  body.type = 'QUOTE_DOUBLE';
  return doc.toString({ lineWidth: 0 });
}

/** Writes `snapshot` to `file` atomically: a uniquely named temp file, then a rename over it. */
async function writeSidecar(file: string, snapshot: SnapshotWire): Promise<void> {
  const text = sidecarText(snapshot);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
