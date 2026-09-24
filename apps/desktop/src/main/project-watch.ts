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
 * How the tree is watched depends on the platform:
 *  - macOS and Windows: one native `fs.watch(dir, { recursive: true })` (FSEvents,
 *    `ReadDirectoryChangesW`), which follows the whole tree in the OS itself.
 *  - Linux: Node implements `recursive: true` there in JavaScript, and that implementation
 *    lists every newly seen subdirectory synchronously inside its own event callback — a
 *    directory that is gone by then (an import's scratch folder renamed away) surfaces as an
 *    `ENOENT … scandir` thrown outside any handler, which takes the main process down. So on
 *    Linux the watcher walks the tree itself: one non-recursive watch per managed directory,
 *    new subdirectories discovered with an async `readdir` when their parent reports a rename,
 *    and a directory that has vanished simply dropped. A platform whose `fs.watch` refuses
 *    `recursive: true` outright falls back to the same walk.
 * Every underlying watch has an `'error'` listener, so a watch whose directory disappears is
 * closed and forgotten rather than crashing the process.
 */

import { readdirSync as nodeReaddirSync, realpathSync, watch as nodeWatch } from 'node:fs';
import { readdir as nodeReaddir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { MAX_FOLDER_DEPTH } from '@wirebench/engine';

/** How long events are coalesced before `onChange` fires. */
export const DEFAULT_DEBOUNCE_MS = 300;

/** How long a path written by the app itself stays suppressed. */
export const SELF_WRITE_TTL_MS = 2_000;

/** The part of `fs.FSWatcher` the watcher relies on. */
export interface WatchHandle {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** The part of `fs.Dirent` the watcher relies on. */
export interface WatchDirEntry {
  readonly name: string;
  isDirectory(): boolean;
}

/** The filesystem calls the watcher makes — injectable so tests can stage a race deterministically. */
export interface WatchFs {
  watch(
    dir: string,
    options: { readonly recursive: boolean },
    listener: (event: string, filename: string | Buffer | null) => void,
  ): WatchHandle;
  readdirSync(dir: string): readonly WatchDirEntry[];
  readdir(dir: string): Promise<readonly WatchDirEntry[]>;
}

const nodeWatchFs: WatchFs = {
  watch: (dir, options, listener) => nodeWatch(dir, options, listener),
  readdirSync: (dir) => nodeReaddirSync(dir, { withFileTypes: true }),
  readdir: (dir) => nodeReaddir(dir, { withFileTypes: true }),
};

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
  /**
   * Which subdirectories (relative to `dir`, `/`-separated) the per-directory watch used on Linux
   * covers. Defaults to {@link isManagedDir}; the workspace-level watcher passes
   * {@link isWorkspaceManagedDir}. Ignored where one native recursive watch covers the tree.
   */
  readonly isWatchedDir?: (dir: string) => boolean;
  /** The platform whose watching strategy applies; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** The filesystem calls to use; defaults to `node:fs`. */
  readonly fs?: WatchFs;
}

/**
 * How deep the per-directory watch goes below the project root: deep enough for an API's deepest
 * folder (`apis/<slug>/requests/` plus `MAX_FOLDER_DEPTH` folders) and an interface's operation
 * folders (`interfaces/<slug>/operations/<slug>`).
 */
const MAX_WATCH_DEPTH = 3 + MAX_FOLDER_DEPTH;

/**
 * True when the per-directory watch should cover `dir` (relative, `/`-separated): anything but a
 * dot-folder (`.git`, a sync client's own state) or an interface's definition cache, neither of
 * which holds a file {@link isManagedPath} would report — and a big cache or a busy `.git` would
 * otherwise mean thousands of watches and a steady stream of directories appearing and vanishing.
 */
export function isManagedDir(dir: string): boolean {
  return dir.split('/').every((segment) => !segment.startsWith('.') && segment !== 'definition');
}

/** The workspace-level counterpart of {@link isManagedDir}: only `environments/` holds its files. */
export function isWorkspaceManagedDir(dir: string): boolean {
  return dir === 'environments';
}

function depthOf(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

function childOf(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function parentOf(dir: string): string {
  const slash = dir.lastIndexOf('/');
  return slash === -1 ? '' : dir.slice(0, slash);
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

/**
 * A pending self-write announcement, returned by {@link ProjectWatcher.announce} and consumed
 * exactly once by {@link ProjectWatcher.release}. Opaque to callers — everything on it is
 * `ProjectWatcher`'s own bookkeeping for the paths that one `announce()` call covered.
 */
export class AnnouncementToken {
  /** Each announced path's self-write expiry from *before* this announcement, or `undefined`
   * when it was not marked at all — what `release()` restores for a path it does not `keep`. */
  readonly priorMarks = new Map<string, number | undefined>();
  /** Announced paths whose event arrived (and was dropped) while owned by *this* announcement —
   * see {@link ProjectWatcher.record}. A drop that happened before this announcement started, or
   * under a different announcement, is never attributed here. */
  readonly dropped = new Set<string>();
}

/** Watches one project folder; created per open project and disposed on close. */
export class ProjectWatcher {
  private readonly options: Required<Omit<ProjectWatcherOptions, 'onChange'>> & Pick<ProjectWatcherOptions, 'onChange'>;
  /**
   * Every live underlying watch, keyed by the directory it covers (relative to `dir`, `''` for the
   * root — which is also the key of the single recursive watch on macOS and Windows).
   */
  private readonly watchers = new Map<string, WatchHandle>();
  /** Directories with an async scan in flight, and those that asked for another once it ends. */
  private readonly scanning = new Set<string>();
  private readonly rescans = new Set<string>();
  /** Bumped by `start()` and `stop()`, so a scan that outlives its watch session does nothing. */
  private generation = 0;
  private readonly pending = new Set<string>();
  /** Relative path to the timestamp after which it is no longer treated as a self-write. */
  private readonly selfWrites = new Map<string, number>();
  /**
   * Which {@link AnnouncementToken} currently owns each announced path — at most one at a time,
   * since usage is always `announce()` then `release()` in sequence. `record()` consults this to
   * route a drop to the right announcement's own `dropped` set; `release()` consults it to know
   * whether it is still the path's owner (an `expect()` call, TTL expiry, or a newer `announce()`
   * of the same path can all take ownership away first, in which case `release()` leaves that
   * path alone entirely).
   */
  private readonly announcedBy = new Map<string, AnnouncementToken>();
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ProjectWatcherOptions) {
    this.options = {
      dir: watchableDir(options.dir),
      onChange: options.onChange,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      selfWriteTtlMs: options.selfWriteTtlMs ?? SELF_WRITE_TTL_MS,
      now: options.now ?? Date.now,
      isManaged: options.isManaged ?? isManagedPath,
      isWatchedDir: options.isWatchedDir ?? isManagedDir,
      platform: options.platform ?? process.platform,
      fs: options.fs ?? nodeWatchFs,
    };
  }

  /** Begins watching. Safe to call once; a second call is a no-op. */
  start(): void {
    if (this.watchers.size > 0) {
      return;
    }
    this.generation += 1;
    if (this.options.platform !== 'linux') {
      try {
        const handle = this.options.fs.watch(this.options.dir, { recursive: true }, (_event, filename) => {
          this.record(filename);
        });
        handle.on('error', () => {
          this.drop('');
        });
        this.watchers.set('', handle);
        return;
      } catch {
        // No native recursive watching here; fall through to the per-directory walk.
      }
    }
    this.watchTree('');
  }

  /** Stops watching and drops any pending batch. */
  stop(): void {
    this.generation += 1;
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.scanning.clear();
    this.rescans.clear();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
    this.announcedBy.clear();
  }

  private absolute(dir: string): string {
    return dir === '' ? this.options.dir : join(this.options.dir, ...dir.split('/'));
  }

  /** True when `dir` (a subdirectory) is one the per-directory walk covers at all. */
  private coversDir(dir: string): boolean {
    return depthOf(dir) <= MAX_WATCH_DEPTH && this.options.isWatchedDir(dir);
  }

  /**
   * Watches `dir` on its own (no-op when it already is). False when it cannot be watched — most
   * often because it vanished a moment ago, which is not an error.
   */
  private watchDir(dir: string): boolean {
    if (this.watchers.has(dir)) {
      return true;
    }
    let handle: WatchHandle;
    try {
      handle = this.options.fs.watch(this.absolute(dir), { recursive: false }, (event, filename) => {
        this.onDirEvent(dir, event, filename);
      });
    } catch {
      return false;
    }
    // Emitted when the watched directory goes away underneath the watch (`EPERM` on Windows,
    // `ENOENT` elsewhere): close it quietly; the parent's rescan already accounts for the removal.
    handle.on('error', () => {
      if (this.watchers.get(dir) === handle) {
        this.drop(dir);
      }
    });
    this.watchers.set(dir, handle);
    return true;
  }

  /** The synchronous walk `start()` does, so every existing directory is covered once it returns. */
  private watchTree(dir: string): void {
    if (!this.watchDir(dir)) {
      return;
    }
    let entries: readonly WatchDirEntry[];
    try {
      entries = this.options.fs.readdirSync(this.absolute(dir));
    } catch {
      // The folder may not exist yet (a brand-new project has no `interfaces/`), or just vanished.
      return;
    }
    for (const entry of entries) {
      const child = childOf(dir, entry.name);
      if (entry.isDirectory() && this.coversDir(child)) {
        this.watchTree(child);
      }
    }
  }

  private onDirEvent(dir: string, event: string, filename: string | Buffer | null): void {
    if (filename !== null) {
      const name = typeof filename === 'string' ? filename : filename.toString('utf8');
      this.record(childOf(dir, this.normalise(name)));
    }
    // A `rename` (or an event the platform could not name) is how a subdirectory appears or
    // disappears; look again at what `dir` now holds.
    if (event === 'rename' || filename === null) {
      this.scan(dir);
    }
  }

  /** Re-lists `dir` asynchronously, coalescing a burst of events into at most one extra pass. */
  private scan(dir: string): void {
    if (this.scanning.has(dir)) {
      this.rescans.add(dir);
      return;
    }
    this.scanning.add(dir);
    const generation = this.generation;
    void this.rescan(dir, generation).finally(() => {
      if (generation !== this.generation) {
        return;
      }
      this.scanning.delete(dir);
      if (this.rescans.delete(dir)) {
        this.scan(dir);
      }
    });
  }

  private async rescan(dir: string, generation: number): Promise<void> {
    let entries: readonly WatchDirEntry[];
    try {
      entries = await this.options.fs.readdir(this.absolute(dir));
    } catch {
      // `dir` itself is gone (or unreadable): nothing under it can be watched any more.
      if (generation === this.generation) {
        this.drop(dir);
      }
      return;
    }
    if (generation !== this.generation || !this.watchers.has(dir)) {
      return;
    }
    const present = new Set<string>();
    for (const entry of entries) {
      const child = childOf(dir, entry.name);
      if (entry.isDirectory() && this.coversDir(child)) {
        present.add(child);
      }
    }
    for (const watched of [...this.watchers.keys()]) {
      if (watched !== '' && parentOf(watched) === dir && !present.has(watched)) {
        this.drop(watched);
      }
    }
    for (const child of present) {
      if (!this.watchers.has(child)) {
        await this.discover(child, generation);
      }
    }
  }

  /**
   * Starts watching a directory that appeared after `start()`, and reports the files already in
   * it: they may well have landed before its watch did (a `git checkout` creating a whole folder).
   */
  private async discover(dir: string, generation: number): Promise<void> {
    if (generation !== this.generation || !this.watchDir(dir)) {
      return;
    }
    let entries: readonly WatchDirEntry[];
    try {
      entries = await this.options.fs.readdir(this.absolute(dir));
    } catch {
      // Gone again between being listed and being scanned: not an error, just nothing to watch.
      if (generation === this.generation) {
        this.drop(dir);
      }
      return;
    }
    if (generation !== this.generation || !this.watchers.has(dir)) {
      return;
    }
    for (const entry of entries) {
      const child = childOf(dir, entry.name);
      if (!entry.isDirectory()) {
        this.record(child);
      } else if (this.coversDir(child) && !this.watchers.has(child)) {
        await this.discover(child, generation);
      }
    }
  }

  /** Closes the watch on `dir` and every watch below it. */
  private drop(dir: string): void {
    for (const [watched, handle] of [...this.watchers]) {
      if (dir === '' || watched === dir || watched.startsWith(`${dir}/`)) {
        this.watchers.delete(watched);
        try {
          handle.close();
        } catch {
          // Already closed by its own failure.
        }
      }
    }
  }

  /**
   * Marks `paths` (relative to the project folder) as written by the app itself, so the
   * events they are about to produce are ignored for the next `selfWriteTtlMs`.
   *
   * A direct call like this always wins over whatever announcement (see {@link announce}) may
   * currently own one of `paths`: that announcement's eventual {@link release} will find this
   * fresher mark already in place and leave the path alone, rather than restoring or re-delivering
   * anything for it.
   */
  expect(paths: readonly string[]): void {
    const until = this.options.now() + this.options.selfWriteTtlMs;
    for (const rawPath of paths) {
      const path = this.normalise(rawPath);
      this.selfWrites.set(path, until);
      this.announcedBy.delete(path);
    }
  }

  /**
   * Marks `paths` self-write *before* a write that covers (a superset of) them runs — see
   * {@link WorkspaceService}'s `candidateWorkspacePaths`, a conservative superset of what a write
   * might touch, announced ahead of time because the write's own atomic renames are each
   * individually visible to `fs.watch` before the write itself returns.
   *
   * Pair every `announce()` with exactly one {@link release} of the token it returns — in a
   * `finally`, so a write that throws still releases. Until then, a genuine outside edit to one
   * of `paths` is provisionally dropped, but remembered (scoped to this announcement only) so
   * `release()` can re-deliver it once the write is known not to have touched it.
   */
  announce(paths: readonly string[]): AnnouncementToken {
    const token = new AnnouncementToken();
    const until = this.options.now() + this.options.selfWriteTtlMs;
    for (const rawPath of paths) {
      const path = this.normalise(rawPath);
      token.priorMarks.set(path, this.selfWrites.get(path));
      this.selfWrites.set(path, until);
      this.announcedBy.set(path, token);
    }
    return token;
  }

  /**
   * Resolves one {@link announce}'d batch now that the write it covered is known to have finished
   * (successfully or not — call this from a `finally`). `keep` is the subset actually touched
   * (typically a `SaveResult`'s `written ∪ removed`): those paths are (re-)marked self-write with
   * a fresh `selfWriteTtlMs`, exactly as a plain {@link expect} would. Every other announced path
   * has its *prior* mark restored — still self-write if it already was (under whatever TTL that
   * mark had left), otherwise not marked at all — and, only for a path this announcement is still
   * the owner of (see {@link announcedBy}), a dropped event *from this announcement* is fed back
   * into the pending batch, unless the restored prior mark still covers it.
   */
  release(token: AnnouncementToken, keep: readonly string[]): void {
    const keepSet = new Set(keep.map((path) => this.normalise(path)));
    const until = this.options.now() + this.options.selfWriteTtlMs;
    let revived = false;
    for (const [path, priorUntil] of token.priorMarks) {
      // Ownership already moved on (a plain `expect()`, TTL expiry, or a newer `announce()` of
      // the same path) — nothing here belongs to this announcement any more.
      if (this.announcedBy.get(path) !== token) {
        continue;
      }
      this.announcedBy.delete(path);
      if (keepSet.has(path)) {
        this.selfWrites.set(path, until);
        continue;
      }
      if (priorUntil === undefined) {
        this.selfWrites.delete(path);
      } else {
        this.selfWrites.set(path, priorUntil);
      }
      if (token.dropped.has(path) && !this.isSelfWrite(path)) {
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
      this.announcedBy.delete(path);
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
      this.announcedBy.get(path)?.dropped.add(path);
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
