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
 *    `recursive: true` outright falls back to the same walk. Each directory is remembered by its
 *    identity (device, inode, creation time), so one deleted and created again under the same
 *    name — which its now-dead watch never reports — is watched afresh.
 * Every underlying watch has an `'error'` listener, so a watch whose directory disappears is
 * closed and forgotten rather than crashing the process; the native recursive watch is restarted
 * a few times after one. A listing that fails for any reason but the directory being gone is
 * retried a few times rather than giving up on the directory.
 */

import { readdirSync as nodeReaddirSync, realpathSync, statSync as nodeStatSync, watch as nodeWatch } from 'node:fs';
import { readdir as nodeReaddir, stat as nodeStat } from 'node:fs/promises';
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

/**
 * The part of `fs.Stats` the watcher relies on: what tells one directory from another of the same
 * name. The inode alone does not — ext4 hands a directory deleted a moment ago's inode straight to
 * the next one created — so the creation time goes with it (`0` where the filesystem keeps none,
 * leaving device and inode to tell them apart).
 */
export interface WatchDirIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeNs?: number | bigint;
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
  statSync(dir: string): WatchDirIdentity;
  stat(dir: string): Promise<WatchDirIdentity>;
}

const nodeWatchFs: WatchFs = {
  watch: (dir, options, listener) => nodeWatch(dir, options, listener),
  readdirSync: (dir) => nodeReaddirSync(dir, { withFileTypes: true }),
  readdir: (dir) => nodeReaddir(dir, { withFileTypes: true }),
  // `bigint`, so an inode past 2^53 (large XFS/Btrfs volumes) still compares exactly, and the
  // creation time is to the nanosecond.
  statSync: (dir) => nodeStatSync(dir, { bigint: true }),
  stat: (dir) => nodeStat(dir, { bigint: true }),
};

/** How many times a failed listing is retried, and a failed native recursive watch restarted. */
const MAX_RETRIES = 3;

/** The first retry's delay; each further one waits that much longer again. */
const DEFAULT_RETRY_DELAY_MS = 500;

/** Error codes that mean the directory is simply not there (any more): nothing to retry. */
const GONE_CODES = new Set(['ENOENT', 'ENOTDIR']);

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function isGone(error: unknown): boolean {
  return GONE_CODES.has(codeOf(error) ?? '');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  /** Where a watch that could not be added or kept is reported; defaults to `console.warn`. */
  readonly log?: (message: string) => void;
  /** The first delay before a failed listing is retried or a failed recursive watch restarted. */
  readonly retryDelayMs?: number;
}

/**
 * How deep the per-directory watch goes below the project root: deep enough for an API's deepest
 * folder (`apis/<slug>/requests/` plus `MAX_FOLDER_DEPTH` folders) and an interface's operation
 * folders (`interfaces/<slug>/operations/<slug>`).
 */
const MAX_WATCH_DEPTH = 3 + MAX_FOLDER_DEPTH;

/** The top-level folders under which {@link isManagedPath} reports files at all. */
const MANAGED_TOP_DIRS = new Set(['interfaces', 'apis', 'environments', 'wss']);

/**
 * True when the per-directory watch should cover `dir` (relative, `/`-separated): a folder that can
 * hold a file {@link isManagedPath} would report — so under `interfaces/`, `apis/`, `environments/`
 * or `wss/`, and never inside an interface's or API's definition cache — and not a dot-folder (a
 * sync client's own state). Everything else (`.git`, `attachments/`, `node_modules/`, a big cache)
 * would otherwise mean thousands of watches, each against the OS's per-user watch limit, and a
 * steady stream of directories appearing and vanishing for nothing.
 */
export function isManagedDir(dir: string): boolean {
  const segments = dir.split('/');
  const top = segments[0] ?? '';
  if (!MANAGED_TOP_DIRS.has(top) || segments.some((segment) => segment.startsWith('.'))) {
    return false;
  }
  // `isManagedPath` skips `/definition/` only under `interfaces/` and `apis/`.
  return (top !== 'interfaces' && top !== 'apis') || !segments.includes('definition');
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

function nameOf(dir: string): string {
  return dir.slice(dir.lastIndexOf('/') + 1);
}

function sameIdentity(a: WatchDirIdentity, b: WatchDirIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
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
  /** The identity each per-directory watch was attached to, keyed like {@link watchers}. */
  private readonly identities = new Map<string, WatchDirIdentity>();
  /** How many times in a row each directory's listing has failed and been retried. */
  private readonly retries = new Map<string, number>();
  /** How many times the native recursive watch has been restarted since `start()`. */
  private restarts = 0;
  /** Pending retry and restart timers, all cancelled by `stop()`. */
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  /** Set once a failure to add a watch has been logged, so a watch limit is reported once, not per directory. */
  private watchFailureLogged = false;
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
      log: options.log ?? console.warn,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    };
  }

  /** Begins watching. Safe to call once; a second call is a no-op. */
  start(): void {
    if (this.watchers.size > 0) {
      return;
    }
    this.generation += 1;
    this.restarts = 0;
    if (this.options.platform !== 'linux') {
      try {
        this.watchRecursive();
        return;
      } catch {
        // No native recursive watching here; fall through to the per-directory walk.
      }
    }
    this.watchTree('');
  }

  /** Adds the single native recursive watch; throws when the platform cannot provide one. */
  private watchRecursive(): void {
    const handle = this.options.fs.watch(this.options.dir, { recursive: true }, (_event, filename) => {
      this.record(filename);
    });
    handle.on('error', (error) => {
      if (this.watchers.get('') !== handle) {
        return;
      }
      this.drop('');
      this.restartRecursive(error, this.generation);
    });
    this.watchers.set('', handle);
  }

  /**
   * Brings the native recursive watch back after it failed — it is the only one there is, so
   * without this the project would silently stop being watched — waiting a little longer before
   * each attempt, and giving up (with a log line) after {@link MAX_RETRIES}.
   */
  private restartRecursive(error: unknown, generation: number): void {
    if (this.restarts >= MAX_RETRIES) {
      this.options.log(`[watch] stopped watching ${this.options.dir}: ${describeError(error)}`);
      return;
    }
    this.restarts += 1;
    this.options.log(
      `[watch] watching ${this.options.dir} failed (${describeError(error)}); restarting (${this.restarts}/${MAX_RETRIES})`,
    );
    this.later(this.options.retryDelayMs * this.restarts, generation, () => {
      if (this.watchers.size > 0) {
        return;
      }
      try {
        this.watchRecursive();
      } catch (restartError) {
        this.restartRecursive(restartError, generation);
      }
    });
  }

  /** Runs `task` after `ms`, unless `stop()` (or a new `start()`) comes first. */
  private later(ms: number, generation: number, task: () => void): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (generation === this.generation) {
        task();
      }
    }, ms);
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  /** Stops watching and drops any pending batch. */
  stop(): void {
    this.generation += 1;
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.identities.clear();
    this.retries.clear();
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
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
   * Watches `dir` on its own (no-op when it already is), remembering `identity` — taken *before*
   * the watch is added, so a directory replaced in between reads as changed on the next scan rather
   * than as the one being watched. False when it cannot be watched — most often because it vanished
   * a moment ago, which is not an error; any other failure (a watch limit: `ENOSPC`, `EMFILE`) is
   * logged, once per watcher.
   */
  private watchDir(dir: string, identity: WatchDirIdentity): boolean {
    if (this.watchers.has(dir)) {
      return true;
    }
    let handle: WatchHandle;
    try {
      handle = this.options.fs.watch(this.absolute(dir), { recursive: false }, (event, filename) => {
        this.onDirEvent(dir, event, filename);
      });
    } catch (error) {
      if (!isGone(error) && !this.watchFailureLogged) {
        this.watchFailureLogged = true;
        this.options.log(
          `[watch] could not watch ${this.absolute(dir)}; changes under it go unnoticed: ${describeError(error)}`,
        );
      }
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
    this.identities.set(dir, identity);
    return true;
  }

  /** `dir`'s identity, or `undefined` when it cannot be read (gone, most likely). */
  private async identify(dir: string): Promise<WatchDirIdentity | undefined> {
    try {
      return await this.options.fs.stat(this.absolute(dir));
    } catch {
      return undefined;
    }
  }

  /** The synchronous walk `start()` does, so every existing directory is covered once it returns. */
  private watchTree(dir: string): void {
    let identity: WatchDirIdentity;
    try {
      identity = this.options.fs.statSync(this.absolute(dir));
    } catch {
      // The folder may not exist yet, or just vanished.
      return;
    }
    if (!this.watchDir(dir, identity)) {
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
      // All a watch says when its own directory is deleted (or renamed away) is a `rename` naming
      // itself, and it then goes quiet for good: have the parent look again, and re-watch the
      // directory if one of that name is back.
      if (dir !== '' && filename !== null && this.normalise(String(filename)) === nameOf(dir)) {
        this.scan(parentOf(dir));
      }
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
    void this.rescan(dir, generation)
      .catch((error: unknown) => {
        this.options.log(`[watch] rescanning ${this.absolute(dir)} failed: ${describeError(error)}`);
      })
      .finally(() => {
        if (generation !== this.generation) {
          return;
        }
        this.scanning.delete(dir);
        if (this.rescans.delete(dir)) {
          this.scan(dir);
        }
      });
  }

  /**
   * After a listing of `dir` failed: a directory that is gone is dropped with everything below it;
   * any other failure (`EMFILE`, `EACCES`, `EBUSY`…) is likely transient, so the watch stays and
   * `retry` runs again after a growing delay, up to {@link MAX_RETRIES} times in a row.
   */
  private listingFailed(dir: string, generation: number, error: unknown, retry: () => void): void {
    if (generation !== this.generation) {
      return;
    }
    if (isGone(error)) {
      this.retries.delete(dir);
      this.drop(dir);
      return;
    }
    const attempt = (this.retries.get(dir) ?? 0) + 1;
    if (attempt > MAX_RETRIES) {
      this.retries.delete(dir);
      this.options.log(`[watch] gave up listing ${this.absolute(dir)}: ${describeError(error)}`);
      return;
    }
    this.retries.set(dir, attempt);
    this.later(this.options.retryDelayMs * attempt, generation, () => {
      if (this.watchers.has(dir)) {
        retry();
      }
    });
  }

  private async rescan(dir: string, generation: number): Promise<void> {
    let entries: readonly WatchDirEntry[];
    try {
      entries = await this.options.fs.readdir(this.absolute(dir));
    } catch (error) {
      this.listingFailed(dir, generation, error, () => this.scan(dir));
      return;
    }
    if (generation !== this.generation || !this.watchers.has(dir)) {
      return;
    }
    this.retries.delete(dir);
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
    // A child that is still there by name may be a different directory: deleted and created again
    // since its watch was added, which leaves that watch dead without a word.
    const watchedChildren = [...present].filter((child) => this.watchers.has(child));
    const identities = await Promise.all(watchedChildren.map((child) => this.identify(child)));
    if (generation !== this.generation) {
      return;
    }
    watchedChildren.forEach((child, index) => {
      const identity = identities[index];
      const known = this.identities.get(child);
      if (identity !== undefined && known !== undefined && !sameIdentity(identity, known)) {
        this.drop(child);
      }
    });
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
    if (generation !== this.generation) {
      return;
    }
    if (!this.watchers.has(dir)) {
      let identity: WatchDirIdentity;
      try {
        identity = await this.options.fs.stat(this.absolute(dir));
      } catch (error) {
        // Gone already is nothing to watch; anything else, the parent's listing is tried again.
        if (!isGone(error)) {
          const parent = parentOf(dir);
          this.listingFailed(parent, generation, error, () => this.scan(parent));
        }
        return;
      }
      if (generation !== this.generation || !this.watchDir(dir, identity)) {
        return;
      }
    }
    let entries: readonly WatchDirEntry[];
    try {
      entries = await this.options.fs.readdir(this.absolute(dir));
    } catch (error) {
      // Gone again between being listed and being scanned is not an error, just nothing to watch.
      this.listingFailed(dir, generation, error, () => void this.discover(dir, generation));
      return;
    }
    if (generation !== this.generation || !this.watchers.has(dir)) {
      return;
    }
    this.retries.delete(dir);
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
        this.identities.delete(watched);
        this.retries.delete(watched);
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
