/**
 * Watches an open project folder for edits made outside Wirebench (a text editor, `git
 * checkout`, a sync client) and reports them as a debounced batch of relative paths.
 *
 * Two things keep the signal useful rather than noisy:
 *  - writes the app itself just made are suppressed, because `saveProject` fires the same
 *    watcher it would take a reload to undo (see {@link ProjectWatcher.expect});
 *  - events are coalesced over {@link DEFAULT_DEBOUNCE_MS}, since one logical save touches
 *    several files and most platforms emit two events per file.
 *
 * macOS and Windows support `fs.watch(dir, { recursive: true })`; Linux does not, so the
 * watcher falls back to one non-recursive watch per managed directory.
 */

import { watch, type FSWatcher } from 'node:fs';
import { readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** How long events are coalesced before `onChange` fires. */
export const DEFAULT_DEBOUNCE_MS = 300;

/** How long a path written by the app itself stays suppressed. */
export const SELF_WRITE_TTL_MS = 2_000;

/** Options for {@link ProjectWatcher}. */
export interface ProjectWatcherOptions {
  /** Absolute path of the project folder. */
  readonly dir: string;
  /** Called with the changed paths, relative to `dir` and `/`-separated. Never called empty. */
  readonly onChange: (paths: readonly string[]) => void;
  readonly debounceMs?: number;
  readonly selfWriteTtlMs?: number;
  /** Injectable clock, so tests can drive the self-write TTL deterministically. */
  readonly now?: () => number;
  /**
   * Which paths under `dir` are worth reporting. Defaults to {@link isManagedPath} (a project
   * folder); the workspace-level watcher passes {@link isWorkspaceManagedPath} instead, since it
   * watches the tree root and must ignore everything under `projects/**`.
   */
  readonly isManaged?: (path: string) => boolean;
}

/**
 * Every directory a non-recursive fallback watch has to cover: the project root and its subtree
 * down to the operation folders (`interfaces/<slug>/operations/<slug>`) and an API's folder tree
 * (`apis/<slug>/requests/<folder>/…`) — deep enough for the whole managed layout, shallow enough
 * that a big definition cache never turns into thousands of watches.
 *
 * An API's folders may nest deeper than this (up to `MAX_FOLDER_DEPTH`); a change below the watched
 * depth is simply not noticed on Linux, which is the same trade the definition cache already makes.
 */
const MAX_WATCH_DEPTH = 5;

function managedDirs(root: string, depth = 0): string[] {
  if (depth > MAX_WATCH_DEPTH) {
    return [];
  }
  const dirs = [root];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push(...managedDirs(join(root, entry.name), depth + 1));
      }
    }
  } catch {
    // The folder may not exist yet (a brand-new project has no `interfaces/`); nothing to watch.
  }
  return dirs;
}

/**
 * True when `path` is one of the files the project format itself owns. Every other event is
 * dropped: platforms report directory-level events (macOS names the watched folder itself)
 * and a project folder may hold a README, notes or a `.git` directory, none of which a
 * reload would change. The definition cache is excluded too — it is written by imports, not
 * by hand, and re-reading it is hydration's job rather than the reload prompt's.
 */
export function isManagedPath(path: string): boolean {
  if (path === 'wirebench.yaml') {
    return true;
  }
  if (path.startsWith('interfaces/')) {
    return !path.includes('/definition/') && (path.endsWith('.yaml') || path.endsWith('.xml'));
  }
  if (path.startsWith('apis/')) {
    // An API's own file, a folder file, a request file — and a raw body, which is edited as the
    // file it is (`Create pet.body.json`), so an external change to one is a change to the request.
    return !path.includes('/definition/') && (path.endsWith('.yaml') || /\.body\.[A-Za-z0-9]+$/.test(path));
  }
  return (path.startsWith('environments/') || path.startsWith('wss/')) && path.endsWith('.yaml');
}

/**
 * True when `path` is one of the files the workspace format itself owns at the tree root:
 * `workspace.yaml`, or one `environments/<name>.yaml` file (one path segment, so a project's own
 * `projects/<slug>/environments/<name>.yaml` — which shares the same suffix — does not match).
 */
export function isWorkspaceManagedPath(path: string): boolean {
  if (path === 'workspace.yaml') {
    return true;
  }
  const parts = path.split('/');
  return parts.length === 2 && parts[0] === 'environments' && parts[1] !== undefined && parts[1].endsWith('.yaml');
}

/**
 * The path to hand `fs.watch`, resolved with the OS's own idea of the name. On Windows the
 * path the app was given may be a short (8.3) or differently-cased form of the directory
 * libuv later reports events under, which trips an assertion inside libuv's `fs-event.c`
 * (`!_wcsnicmp(filename, dir, dirlen)`); `realpathSync.native` returns the canonical form.
 * Falls back to the path as given when it cannot be resolved (a folder not created yet).
 */
function watchableDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
}

/** Watches one project folder; created per open project and disposed on close. */
export class ProjectWatcher {
  private readonly options: Required<Omit<ProjectWatcherOptions, 'onChange'>> & Pick<ProjectWatcherOptions, 'onChange'>;
  private readonly watchers: FSWatcher[] = [];
  private readonly pending = new Set<string>();
  /** Relative path to the timestamp after which it is no longer treated as a self-write. */
  private readonly selfWrites = new Map<string, number>();
  /**
   * Paths whose event arrived while marked self-write (so `record()` dropped it) and have not
   * been un-marked since. `unexpect()` consults this to re-deliver a genuine outside edit that a
   * too-broad `expect()` call (a conservative superset, not an exact diff) happened to suppress.
   */
  private readonly droppedWhileExpected = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ProjectWatcherOptions) {
    this.options = {
      dir: watchableDir(options.dir),
      onChange: options.onChange,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      selfWriteTtlMs: options.selfWriteTtlMs ?? SELF_WRITE_TTL_MS,
      now: options.now ?? Date.now,
      isManaged: options.isManaged ?? isManagedPath,
    };
  }

  /** Begins watching. Safe to call once; a second call is a no-op. */
  start(): void {
    if (this.watchers.length > 0) {
      return;
    }
    try {
      this.watchers.push(
        watch(this.options.dir, { recursive: true }, (_event, filename) => {
          this.record(filename);
        }),
      );
      return;
    } catch {
      // Recursive watching is unsupported here (Linux); fall through to per-directory watches.
    }
    for (const dir of managedDirs(this.options.dir)) {
      try {
        this.watchers.push(
          watch(dir, (_event, filename) => {
            this.record(filename === null ? null : join(relative(this.options.dir, dir), filename));
          }),
        );
      } catch {
        // A directory that vanished between listing and watching is not an error.
      }
    }
  }

  /** Stops watching and drops any pending batch. */
  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.length = 0;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
    this.droppedWhileExpected.clear();
  }

  /**
   * Marks `paths` (relative to the project folder) as written by the app itself, so the
   * events they are about to produce are ignored for the next `selfWriteTtlMs`.
   */
  expect(paths: readonly string[]): void {
    const until = this.options.now() + this.options.selfWriteTtlMs;
    for (const path of paths) {
      this.selfWrites.set(this.normalise(path), until);
    }
  }

  /**
   * Un-marks `paths` as self-write, ahead of `selfWriteTtlMs` — for a candidate `expect()` turned
   * out not to touch (see {@link WorkspaceService}'s `candidateWorkspacePaths`, a conservative
   * superset announced before the write it covers, not an exact diff of what the write changed).
   *
   * If an event for one of `paths` already arrived while it was still marked (and so `record()`
   * dropped it), that path is fed back into the pending batch so the normal debounce still
   * delivers it — an outside edit made to an untouched file during the write's window must not be
   * lost just because it briefly looked, in advance, like something the write might touch.
   */
  unexpect(paths: readonly string[]): void {
    let revived = false;
    for (const rawPath of paths) {
      const path = this.normalise(rawPath);
      this.selfWrites.delete(path);
      if (this.droppedWhileExpected.delete(path)) {
        this.pending.add(path);
        revived = true;
      }
    }
    if (revived) {
      this.schedule();
    }
  }

  private normalise(path: string): string {
    return path.split(sep).join('/');
  }

  private isSelfWrite(path: string): boolean {
    const until = this.selfWrites.get(path);
    if (until === undefined) {
      return false;
    }
    if (this.options.now() > until) {
      this.selfWrites.delete(path);
      return false;
    }
    return true;
  }

  private record(filename: string | Buffer | null): void {
    if (filename === null) {
      return;
    }
    const path = this.normalise(typeof filename === 'string' ? filename : filename.toString('utf8'));
    if (!this.options.isManaged(path)) {
      return;
    }
    if (this.isSelfWrite(path)) {
      this.droppedWhileExpected.add(path);
      return;
    }
    this.pending.add(path);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const paths = [...this.pending].sort();
      this.pending.clear();
      if (paths.length > 0) {
        this.options.onChange(paths);
      }
    }, this.options.debounceMs);
    this.timer.unref?.();
  }
}
