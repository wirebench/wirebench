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
  private readonly watchers: FSWatcher[] = [];
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
    this.announcedBy.clear();
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
