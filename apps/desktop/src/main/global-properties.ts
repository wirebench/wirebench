/**
 * The user's global properties: the `${#Global#name}` scope, shared by every project and so
 * stored in Electron's `userData` directory rather than in any project folder.
 *
 * The file is YAML (`{ version: 2, properties: { … }, disabled: [ … ] }`) to match the project
 * and workspace file formats, and is written atomically so a crash mid-write cannot leave a
 * half-written map behind. A missing, malformed or unexpectedly-shaped file yields an empty
 * state: broken globals must never stop the app from starting. The one file that is refused
 * rather than read is one stamped with a `version` newer than this build's — reading it would
 * mean the next write rewriting it at this version with the parts this build cannot see
 * dropped, so `load` rejects and every mutator rejects with it, leaving the file untouched.
 *
 * `disabled` names a property whose value is skipped during resolution (see the engine's
 * `enabledProperties`) without deleting it — the same per-variable enabled flag the project and
 * workspace formats carry. A version-1 file (no `disabled` key) reads as an empty list; this
 * module owns its own version bump, distinct from the engine's own file formats.
 *
 * No `electron` import — the caller passes the `userData` directory in, which keeps this
 * unit-testable against a temp folder.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { WirebenchError } from '@wirebench/engine';
import type { GlobalsState } from '../shared/wire-types.js';

/** File name (inside `userData`) the global properties are persisted to. */
export const GLOBAL_PROPERTIES_FILE = 'global-properties.yaml';

/** The file format version this build writes. A v1 file (no `disabled` key) reads as `[]`. */
const FORMAT_VERSION = 2;

/** A flat property map, matching the engine's `PropertyMap`. */
export type PropertyMap = Record<string, string>;

/** The global properties, plus which of them are currently disabled — the shape the wire carries. */
export type { GlobalsState };

/**
 * Reads the `properties` map out of a parsed document, keeping only string values — a YAML
 * scalar such as `port: 8080` parses to a number, which has no place in a property scope.
 */
function propertiesFrom(document: unknown): PropertyMap {
  if (typeof document !== 'object' || document === null) {
    return {};
  }
  const raw = (document as { properties?: unknown }).properties;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const properties: PropertyMap = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      properties[name] = value;
    }
  }
  return properties;
}

/**
 * Refuses a file written by a newer build, the way the project and workspace loaders do
 * (`engine/project/migrate.ts`): without this, a future version-3 file would be read as if it
 * were a v2 and the very next write would stamp it back at `version: 2` with every key this
 * build does not know silently dropped — the user's globals destroyed by a build that should
 * have declined to touch them. A missing, non-numeric or `<= FORMAT_VERSION` version reads
 * exactly as before, which is what the v1 → v2 migration needs.
 *
 * @throws WirebenchError `globals-format-too-new`.
 */
function assertVersionSupported(document: unknown, file: string): void {
  if (typeof document !== 'object' || document === null) {
    return;
  }
  const version = (document as { version?: unknown }).version;
  if (typeof version === 'number' && Number.isInteger(version) && version > FORMAT_VERSION) {
    throw new WirebenchError(
      'globals-format-too-new',
      `Global properties were written by a newer version of Wirebench (format ${String(version)}, this build supports ${String(FORMAT_VERSION)})`,
      { details: { file, version, supported: FORMAT_VERSION } },
    );
  }
}

/** Reads the `disabled` list out of a parsed document, keeping only string entries. */
function disabledFrom(document: unknown): readonly string[] {
  if (typeof document !== 'object' || document === null) {
    return [];
  }
  const raw = (document as { disabled?: unknown }).disabled;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((name): name is string => typeof name === 'string');
}

/**
 * The `disabled` list as written: sorted, deduplicated, and dropped entirely once it would be
 * empty or once every name in it has no entry left in `properties` — mirrors the engine's own
 * `disabled` list convention for the project and workspace formats.
 */
function disabledList(disabled: readonly string[], properties: PropertyMap): readonly string[] {
  const known = new Set(Object.keys(properties));
  return [...new Set(disabled.filter((name) => known.has(name)))].sort();
}

/** Writes `data` to `path` via a sibling temp file renamed over the target. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Owns the global property map (and its `disabled` list) for one `userData` directory.
 * {@link get} is synchronous so the send path can build property scopes without awaiting a disk
 * read; call {@link load} once at startup (every mutator loads on demand too, so a forgotten
 * `load` cannot lose data).
 */
export class GlobalProperties {
  private readonly file: string;
  private properties: PropertyMap = {};
  private disabled: readonly string[] = [];
  private loaded = false;
  private loadPromise: Promise<GlobalsState> | undefined;
  /**
   * Serialises every write: each write chains off this promise instead of `this.properties`
   * directly, so two overlapping `set`/`remove`/`replaceAll`/`setEnabled` calls read the latest
   * state rather than racing to persist stale snapshots and silently dropping one another's
   * edits.
   */
  private queue: Promise<GlobalsState> = Promise.resolve(this.get());

  constructor(userDataDir: string) {
    this.file = join(userDataDir, GLOBAL_PROPERTIES_FILE);
  }

  /**
   * Reads the file into memory, returning the state. Safe to call more than once — concurrent
   * calls (e.g. the startup warm-up racing an early `globals.get`) share the same in-flight read
   * rather than each issuing their own.
   */
  async load(): Promise<GlobalsState> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    const loadPromise = this.doLoad();
    this.loadPromise = loadPromise;
    return loadPromise;
  }

  private async doLoad(): Promise<GlobalsState> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      this.properties = {};
      this.disabled = [];
      this.loaded = true;
      return this.get();
    }
    let document: unknown;
    try {
      document = parseYaml(text);
    } catch {
      this.properties = {};
      this.disabled = [];
      this.loaded = true;
      return this.get();
    }
    // Deliberately outside the catch above: a file this build cannot safely rewrite must be
    // refused, not read as an empty map that the next write would then overwrite.
    assertVersionSupported(document, this.file);
    this.properties = propertiesFrom(document);
    this.disabled = disabledFrom(document);
    this.loaded = true;
    return this.get();
  }

  /**
   * Resolves once the initial `load()` has completed. Every read/write handler awaits this
   * before touching `properties`, so an early call (before `main/index.ts`'s startup warm-up
   * finishes) sees on-disk state rather than the empty default.
   */
  ready(): Promise<GlobalsState> {
    return this.load();
  }

  /** The current state. A defensive copy: callers must go through the mutators below. */
  get(): GlobalsState {
    return { properties: { ...this.properties }, disabled: [...this.disabled] };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private async persist(properties: PropertyMap, disabled: readonly string[]): Promise<GlobalsState> {
    const kept = disabledList(disabled, properties);
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeAtomic(
      this.file,
      stringifyYaml(
        { version: FORMAT_VERSION, properties, ...(kept.length > 0 ? { disabled: kept } : {}) },
        { sortMapEntries: true, lineWidth: 0 },
      ),
    );
    this.properties = properties;
    this.disabled = kept;
    this.loaded = true;
    return this.get();
  }

  /** Queues `op` after every previously queued write, so it always reads the latest state. */
  private enqueue(op: () => Promise<GlobalsState>): Promise<GlobalsState> {
    const next = this.queue.then(async () => {
      await this.ensureLoaded();
      return op();
    });
    // Swallow rejection on the queue chain itself (the caller's own await still sees it) so one
    // failed write does not permanently wedge every write after it.
    this.queue = next.catch(() => this.get());
    return next;
  }

  /** Sets one property, returning the resulting state. */
  set(name: string, value: string): Promise<GlobalsState> {
    return this.enqueue(() => this.persist({ ...this.properties, [name]: value }, this.disabled));
  }

  /** Removes one property (a no-op when it is absent), returning the resulting state. */
  remove(name: string): Promise<GlobalsState> {
    return this.enqueue(() => {
      const next = { ...this.properties };
      delete next[name];
      return this.persist(next, this.disabled);
    });
  }

  /** Replaces the whole map — what a properties table sends after an edit. */
  replaceAll(properties: PropertyMap): Promise<GlobalsState> {
    return this.enqueue(() => this.persist({ ...properties }, this.disabled));
  }

  /**
   * Enables or disables one property without deleting it — the per-variable checkbox in the
   * environments UI. Disabling a name the map does not have is a harmless no-op: {@link persist}
   * drops any `disabled` entry with no matching property on the very next write.
   */
  setEnabled(name: string, enabled: boolean): Promise<GlobalsState> {
    return this.enqueue(() => {
      const next = enabled ? this.disabled.filter((candidate) => candidate !== name) : [...this.disabled, name];
      return this.persist(this.properties, next);
    });
  }
}
