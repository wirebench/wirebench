/**
 * The user's application preferences: HTTP/proxy/TLS defaults, WSDL and WS-I options, editor
 * and shell settings. Like the global property map these belong to the *user*, not to any
 * project, so they live in Electron's `userData` directory rather than in a project folder.
 *
 * The file is YAML (`{ version: 1, ...sections }`) to match the project files, written
 * atomically so a crash mid-write cannot leave half a document behind, and merged onto
 * {@link DEFAULT_PREFERENCES} on the way in — a missing, malformed or partial file yields
 * usable defaults rather than stopping the app from starting.
 *
 * No `electron` import: the caller passes the `userData` directory in, which keeps this
 * unit-testable against a temp folder.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { DEFAULT_PREFERENCES, mergePreferences, resetPreferences } from '@wirebench/engine';
import type { Preferences, PreferencesPatch, PreferencesSection } from '@wirebench/engine';

import type { PreferencesWire } from '../shared/wire-types.js';

/**
 * The JSON-plain, mutable mirror of a {@link Preferences} document. A structural clone rather
 * than a cast: the engine's shape is deeply `readonly` (and its arrays are `readonly`), which
 * the wire schemas an IPC response is validated against cannot express.
 */
export function toPreferencesWire(preferences: Preferences): PreferencesWire {
  return JSON.parse(JSON.stringify(preferences)) as PreferencesWire;
}

/**
 * Re-records a CA bundle the user picked in an earlier session as a read pick for this one.
 *
 * Only a path carrying `ssl.caBundlePickedByMain` qualifies: that marker is written by
 * `ssl.pickCaBundle` after a native dialog and by nothing else, so it is the same evidence a
 * fresh pick would be. A `preferences.yaml` edited by hand — or a path that reached the file
 * some other way — has no marker and gets no pick, which leaves the bundle untrusted (see
 * `ProjectHost.trustAnchors`, which still runs the full `allowsReadPath` check) until the
 * user picks it again. Without this, every restart would silently stop trusting a bundle that
 * lives outside the project folder.
 *
 * @param preferences the loaded preferences document
 * @param picks the session's picked-path memory
 * @returns the path that was re-recorded, or `undefined` when none was
 */
export function rememberPickedCaBundle(
  preferences: Preferences,
  picks: { rememberRead(path: string): void },
): string | undefined {
  const { caBundlePath, caBundlePickedByMain } = preferences.ssl;
  if (caBundlePickedByMain !== true || caBundlePath === undefined || caBundlePath.length === 0) {
    return undefined;
  }
  picks.rememberRead(caBundlePath);
  return caBundlePath;
}

/** File name (inside `userData`) the preferences are persisted to. */
export const PREFERENCES_FILE = 'preferences.yaml';

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
 * Owns the preferences document for one `userData` directory. {@link get} is synchronous so
 * the send path can read preferences without awaiting a disk read; {@link ready} resolves once
 * the initial load has completed, and every mutator loads on demand.
 */
export class PreferencesService {
  private readonly file: string;
  private preferences: Preferences = DEFAULT_PREFERENCES;
  private loaded = false;
  private loadPromise: Promise<Preferences> | undefined;
  /** Serialises writes, so two overlapping updates cannot each persist a stale snapshot. */
  private queue: Promise<Preferences> = Promise.resolve(DEFAULT_PREFERENCES);
  private readonly listeners = new Set<(preferences: Preferences) => void>();

  constructor(userDataDir: string) {
    this.file = join(userDataDir, PREFERENCES_FILE);
  }

  /** Reads the file into memory. Safe to call more than once; concurrent calls share one read. */
  async load(): Promise<Preferences> {
    this.loadPromise ??= this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<Preferences> {
    let document: unknown;
    try {
      document = parseYaml(await readFile(this.file, 'utf8'));
    } catch {
      document = undefined;
    }
    this.preferences = mergePreferences(document);
    this.loaded = true;
    return this.preferences;
  }

  /** Resolves once the initial {@link load} has completed. */
  ready(): Promise<Preferences> {
    return this.load();
  }

  /** The current preferences. Frozen sections; go through {@link update} to change them. */
  get(): Preferences {
    return this.preferences;
  }

  /** Subscribes to every change; returns an unsubscribe. */
  onChange(listener: (preferences: Preferences) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async persist(next: Preferences): Promise<Preferences> {
    await mkdir(join(this.file, '..'), { recursive: true });
    await writeAtomic(this.file, stringifyYaml({ version: 1, ...next }, { lineWidth: 0 }));
    this.preferences = next;
    this.loaded = true;
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  /** Queues `op` after every previously queued write, so it always reads the latest state. */
  private enqueue(op: () => Promise<Preferences>): Promise<Preferences> {
    const next = this.queue.then(async () => {
      if (!this.loaded) {
        await this.load();
      }
      return op();
    });
    // Swallow rejection on the queue chain itself (the caller's own await still sees it) so one
    // failed write does not permanently wedge every write after it.
    this.queue = next.catch(() => this.preferences);
    return next;
  }

  /** Deep-merges `patch` into the current preferences and persists the result. */
  update(patch: PreferencesPatch): Promise<Preferences> {
    return this.enqueue(() => this.persist(mergePreferences(patch, this.preferences)));
  }

  /** Restores one section — or, with no section, everything — to its default. */
  reset(section?: PreferencesSection): Promise<Preferences> {
    return this.enqueue(() => this.persist(resetPreferences(this.preferences, section)));
  }
}
