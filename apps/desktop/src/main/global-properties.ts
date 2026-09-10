/**
 * The user's global properties: the `${#Global#name}` scope, shared by every project and so
 * stored in Electron's `userData` directory rather than in any project folder.
 *
 * The file is YAML (`{ version: 1, properties: { … } }`) to match the project files, and is
 * written atomically so a crash mid-write cannot leave a half-written map behind. A missing,
 * malformed or unexpectedly-shaped file yields an empty map: broken globals must never stop
 * the app from starting.
 *
 * No `electron` import — the caller passes the `userData` directory in, which keeps this
 * unit-testable against a temp folder.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** File name (inside `userData`) the global properties are persisted to. */
export const GLOBAL_PROPERTIES_FILE = 'global-properties.yaml';

/** A flat property map, matching the engine's `PropertyMap`. */
export type PropertyMap = Record<string, string>;

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
 * Owns the global property map for one `userData` directory. {@link get} is synchronous so the
 * send path can build property scopes without awaiting a disk read; call {@link load} once at
 * startup (every mutator loads on demand too, so a forgotten `load` cannot lose data).
 */
export class GlobalProperties {
  private readonly file: string;
  private properties: PropertyMap = {};
  private loaded = false;
  private loadPromise: Promise<PropertyMap> | undefined;
  /**
   * Serialises every write: each write chains off this promise instead of `this.properties`
   * directly, so two overlapping `set`/`remove`/`replaceAll` calls read the latest state rather
   * than racing to persist stale snapshots and silently dropping one another's edits.
   */
  private queue: Promise<PropertyMap> = Promise.resolve(this.properties);

  constructor(userDataDir: string) {
    this.file = join(userDataDir, GLOBAL_PROPERTIES_FILE);
  }

  /**
   * Reads the file into memory, returning the map. Safe to call more than once — concurrent
   * calls (e.g. the startup warm-up racing an early `globals.get`) share the same in-flight read
   * rather than each issuing their own.
   */
  async load(): Promise<PropertyMap> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    const loadPromise = this.doLoad();
    this.loadPromise = loadPromise;
    return loadPromise;
  }

  private async doLoad(): Promise<PropertyMap> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      this.properties = {};
      this.loaded = true;
      return this.get();
    }
    try {
      this.properties = propertiesFrom(parseYaml(text));
    } catch {
      this.properties = {};
    }
    this.loaded = true;
    return this.get();
  }

  /**
   * Resolves once the initial `load()` has completed. Every read/write handler awaits this
   * before touching `properties`, so an early call (before `main/index.ts`'s startup warm-up
   * finishes) sees on-disk state rather than the empty default.
   */
  ready(): Promise<PropertyMap> {
    return this.load();
  }

  /** The current map. A defensive copy: callers must go through {@link set}/{@link remove}. */
  get(): PropertyMap {
    return { ...this.properties };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private async persist(properties: PropertyMap): Promise<PropertyMap> {
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeAtomic(this.file, stringifyYaml({ version: 1, properties }, { sortMapEntries: true, lineWidth: 0 }));
    this.properties = properties;
    this.loaded = true;
    return this.get();
  }

  /** Queues `op` after every previously queued write, so it always reads the latest state. */
  private enqueue(op: () => Promise<PropertyMap>): Promise<PropertyMap> {
    const next = this.queue.then(async () => {
      await this.ensureLoaded();
      return op();
    });
    // Swallow rejection on the queue chain itself (the caller's own await still sees it) so one
    // failed write does not permanently wedge every write after it.
    this.queue = next.catch(() => this.get());
    return next;
  }

  /** Sets one property, returning the resulting map. */
  set(name: string, value: string): Promise<PropertyMap> {
    return this.enqueue(() => this.persist({ ...this.properties, [name]: value }));
  }

  /** Removes one property (a no-op when it is absent), returning the resulting map. */
  remove(name: string): Promise<PropertyMap> {
    return this.enqueue(() => {
      const next = { ...this.properties };
      delete next[name];
      return this.persist(next);
    });
  }

  /** Replaces the whole map — what a properties table sends after an edit. */
  replaceAll(properties: PropertyMap): Promise<PropertyMap> {
    return this.enqueue(() => this.persist({ ...properties }));
  }
}
