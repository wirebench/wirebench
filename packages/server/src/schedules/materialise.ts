/**
 * A run's private copy of the workspace (scheduled-runs spec §3.2 step 1), written from a
 * `CommitStore` snapshot to `<root>/<runId>/` with mode 0700. It is written in two steps: the
 * manifest and the environments first, so the executor can find the target project's folder, then
 * that one project. Team-secret files and other projects are never written.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { SyncFile } from '@wirebench/engine';
import { RunStopped } from './outcome.js';

export interface MaterialiseInput {
  /** Absolute: the tenant's `tmp/schedules` (spec §19.6). */
  readonly root: string;
  readonly runId: string;
  readonly files: readonly SyncFile[];
  /** The most decoded bytes the written files may hold, the project's included. */
  readonly maxBytes: number;
}

export interface Materialised {
  readonly dir: string;
  /** Writes `projects/<slug>/**`. @throws RunStopped `target-invalid`, `snapshot-too-large` */
  addProject(slug: string): Promise<void>;
  /** Removes the directory; safe to call twice. */
  dispose(): Promise<void>;
}

/** A path segment git and every supported file system agree on; the push route already refused worse. */
const segment = (text: string): boolean =>
  text !== '' && text !== '.' && text !== '..' && !/[\\\u0000]/.test(text) && !text.includes('/');

const safePath = (path: string): boolean => path.split('/').every(segment);

export async function materialise(input: MaterialiseInput): Promise<Materialised> {
  if (!segment(input.runId)) throw new RunStopped('target-invalid', 'The run id is not one path segment.');
  if (input.files.some((file) => !safePath(file.path))) {
    throw new RunStopped('snapshot-path-refused', 'The snapshot names a path outside its tree.');
  }
  const dir = resolve(input.root, input.runId);
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  let written = 0;

  const write = async (files: readonly SyncFile[]): Promise<void> => {
    const decoded = files.map((file) => ({ path: file.path, bytes: Buffer.from(file.content, file.encoding) }));
    written += decoded.reduce((sum, file) => sum + file.bytes.length, 0);
    if (written > input.maxBytes) {
      throw new RunStopped('snapshot-too-large', `The snapshot is over the ${input.maxBytes}-byte cap.`);
    }
    for (const file of decoded) {
      const target = resolve(dir, ...file.path.split('/'));
      // Belt and braces after `safePath`: nothing is written outside the run's directory.
      if (!target.startsWith(dir + sep)) throw new RunStopped('snapshot-path-refused');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { mode: 0o600 });
    }
  };
  const guarded = async (step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      await dispose();
      throw error;
    }
  };

  await mkdir(input.root, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  await guarded(() =>
    write(input.files.filter((file) => file.path === 'workspace.yaml' || file.path.startsWith('environments/'))),
  );
  return {
    dir,
    addProject: (slug) =>
      guarded(async () => {
        if (!segment(slug)) throw new RunStopped('target-invalid', 'The project is not one path segment.');
        const prefix = `projects/${slug}/`;
        await write(input.files.filter((file) => file.path.startsWith(prefix)));
      }),
    dispose,
  };
}
