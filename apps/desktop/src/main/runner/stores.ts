/**
 * What the Runner keeps between runs (#336), in the app's own storage and never in a project (spec
 * D4): each target's settings and data file in `<userData>/runner-settings.json`, and its last runs,
 * masked, in `<userData>/runner-history/<hash of the target id>.json`. No `electron` import: the
 * caller passes the `userData` directory in. A missing or corrupt file reads as empty.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { defaultRunnerSettings, RUNNER_HISTORY_LIMIT } from '../../shared/runner-defaults.js';
import { runnerRunResultSchema, runnerSettingsSchema } from '../../shared/runner-wire.js';
import type { RunnerHistoryEntry, RunnerRunResult, RunnerSettings } from '../../shared/runner-wire.js';

export const RUNNER_SETTINGS_FILE = 'runner-settings.json';
export const RUNNER_HISTORY_DIR = 'runner-history';

/** A target's settings, and the data file main keeps for it. */
export interface StoredRunnerTarget {
  readonly settings: RunnerSettings;
  /** The data file's absolute path; it never crosses to the renderer (ADR-0005). */
  readonly dataPath?: string | undefined;
}

const settingsFileSchema = z.object({
  version: z.literal(1),
  targets: z.record(z.string(), z.object({ settings: runnerSettingsSchema, dataPath: z.string().optional() })),
});
type SettingsFile = z.infer<typeof settingsFileSchema>;

const historyFileSchema = z.object({ version: z.literal(1), runs: z.array(runnerRunResultSchema) });
type HistoryFile = z.infer<typeof historyFileSchema>;

const defaults = (): RunnerSettings => defaultRunnerSettings();

/** Writes `data` to `path` via a sibling temp file renamed over the target. */
async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(temp, data, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** `file` parsed by `schema`, or undefined when it is missing, unreadable or not that shape. */
async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** One change after another, so two quick writes never lose either. */
class WriteQueue {
  private queue: Promise<void> = Promise.resolve();

  run(write: () => Promise<void>): Promise<void> {
    const next = this.queue.then(write, write);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export class RunnerSettingsStore {
  private readonly file: string;
  private readonly writes = new WriteQueue();

  constructor(userDataDir: string) {
    this.file = join(userDataDir, RUNNER_SETTINGS_FILE);
  }

  private async read(): Promise<SettingsFile> {
    return (await readJson(this.file, settingsFileSchema)) ?? { version: 1, targets: {} };
  }

  private update(targetId: string, change: (target: StoredRunnerTarget) => StoredRunnerTarget): Promise<void> {
    return this.writes.run(async () => {
      const file = await this.read();
      const current = Object.hasOwn(file.targets, targetId) ? file.targets[targetId]! : { settings: defaults() };
      const next: SettingsFile = { version: 1, targets: { ...file.targets, [targetId]: change(current) } };
      await writeAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
    });
  }

  /** The target's settings, or the defaults for a target never configured. */
  async get(targetId: string): Promise<StoredRunnerTarget> {
    const file = await this.read();
    return Object.hasOwn(file.targets, targetId) ? file.targets[targetId]! : { settings: defaults() };
  }

  setSettings(targetId: string, settings: RunnerSettings): Promise<void> {
    return this.update(targetId, (target) => ({ ...target, settings }));
  }

  /** Keeps `path` as the target's data file, or forgets it for `undefined`. */
  setDataPath(targetId: string, path: string | undefined): Promise<void> {
    return this.update(targetId, ({ settings }) => ({ settings, ...(path !== undefined ? { dataPath: path } : {}) }));
  }
}

export class RunnerHistoryStore {
  private readonly dir: string;
  private readonly writes = new WriteQueue();

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, RUNNER_HISTORY_DIR);
  }

  /** A target's file, named by a hash of its id so no id can name a path outside the folder. */
  private fileOf(targetId: string): string {
    return join(this.dir, `${createHash('sha256').update(targetId).digest('hex').slice(0, 32)}.json`);
  }

  private async runs(targetId: string): Promise<HistoryFile['runs']> {
    return (await readJson(this.fileOf(targetId), historyFileSchema))?.runs ?? [];
  }

  /** The target's runs, newest first, without their requests. */
  async list(targetId: string): Promise<RunnerHistoryEntry[]> {
    return (await this.runs(targetId)).map(({ runId, startedAt, environment, dataFile, cancelled, summary }) => ({
      runId,
      startedAt,
      ...(environment !== undefined ? { environment } : {}),
      ...(dataFile !== undefined ? { dataFile } : {}),
      cancelled,
      summary,
    }));
  }

  async get(targetId: string, runId: string): Promise<RunnerRunResult | undefined> {
    return (await this.runs(targetId)).find((run) => run.runId === runId);
  }

  /** Keeps `run` as its target's newest, dropping the oldest past the limit. */
  add(run: RunnerRunResult): Promise<void> {
    return this.writes.run(async () => {
      const runs = [run, ...(await this.runs(run.targetId))].slice(0, RUNNER_HISTORY_LIMIT);
      const file: HistoryFile = { version: 1, runs };
      await writeAtomic(this.fileOf(run.targetId), JSON.stringify(file));
    });
  }
}
