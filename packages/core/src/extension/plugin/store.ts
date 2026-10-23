/**
 * Where installed plugins live and how they get there (phase 7 spec §6, ADR-0031).
 *
 * `<userData>/plugins/<id>/` holds each plugin's manifest, its module and an optional README and
 * LICENSE; `<userData>/plugins.lock.json`, outside the plugin folders, holds the SHA-256 of the
 * manifest and the module the person installed. Nothing else is read for plugins: no project file,
 * no environment variable, no flag names another folder.
 *
 * Installing stages the plugin in memory first (so the person can be shown what it contributes and
 * which origins it may reach), then writes it beside the others and renames it into place. Loading
 * is synchronous, once per process: a plugin folder that is a symlink, has no lock entry, or no
 * longer matches its hashes is skipped with a problem; the module is read once, and the bytes that
 * were hashed are the bytes that run.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WirebenchError } from '../../errors.js';
import { MANIFEST_FILE, parsePluginManifest, PLUGIN_API_MAJOR, type PluginManifestData } from './manifest.js';
import { readTgz, TarError } from './tar.js';

export const PLUGINS_DIR = 'plugins';
export const LOCK_FILE = 'plugins.lock.json';

/** The most one plugin file may hold. */
const FILE_BYTES = 16 * 1024 * 1024;

/** Besides the manifest and its module, the files an install keeps; anything else is left behind. */
const EXTRA_FILES = new Set(['README', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt']);

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const lockSchema = z.strictObject({
  lockVersion: z.literal(1),
  plugins: z.record(
    z.string(),
    z.strictObject({
      version: z.string(),
      manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
      mainSha256: z.string().regex(/^[0-9a-f]{64}$/),
      installedAt: z.string(),
    }),
  ),
});

export type PluginLock = z.infer<typeof lockSchema>;
export type PluginLockEntry = PluginLock['plugins'][string];

/** A plugin read from where the person pointed, not yet written anywhere. */
export interface StagedPlugin {
  readonly manifest: PluginManifestData;
  /** The files an install writes, by name: the manifest, its module, README and LICENSE. */
  readonly files: ReadonlyMap<string, Buffer>;
}

/** A plugin loaded for this process: its manifest and the module text that was hashed. */
export interface InstalledPlugin {
  readonly manifest: PluginManifestData;
  readonly code: string;
  readonly dir: string;
}

export type PluginProblemCode =
  'plugin-manifest-invalid' | 'plugin-api-mismatch' | 'plugin-modified' | 'plugin-not-installed';

export interface PluginProblem {
  /** The folder's name: the plugin's id when its manifest says the same. */
  readonly id: string;
  readonly code: PluginProblemCode;
  readonly message: string;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export const pluginsDirOf = (userData: string): string => join(userData, PLUGINS_DIR);
export const lockFileOf = (userData: string): string => join(userData, LOCK_FILE);

function refused(message: string): WirebenchError {
  return new WirebenchError('plugin-install-refused', message);
}

function invalid(problems: readonly string[]): WirebenchError {
  return new WirebenchError('plugin-manifest-invalid', `${MANIFEST_FILE} is not valid: ${problems.join('; ')}`, {
    details: { problems },
  });
}

/** One regular file, read without following a link, at most {@link FILE_BYTES}. */
async function readRegular(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW).catch((error: unknown) => {
    throw refused(`${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw refused(`${path} is not a regular file`);
    if (stat.size > FILE_BYTES) throw refused(`${path} is larger than 16 MiB`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function staged(files: ReadonlyMap<string, Buffer>): StagedPlugin {
  const manifestBytes = files.get(MANIFEST_FILE);
  if (manifestBytes === undefined) throw refused(`there is no ${MANIFEST_FILE}`);
  const parsed = parsePluginManifest(manifestBytes.toString('utf8'));
  if (!parsed.ok) throw invalid(parsed.problems);
  const { manifest } = parsed;
  if (manifest.api !== PLUGIN_API_MAJOR) {
    throw new WirebenchError(
      'plugin-api-mismatch',
      `${manifest.id} is written for plugin API ${String(manifest.api)}; this Wirebench loads API ${String(PLUGIN_API_MAJOR)}`,
    );
  }
  const main = files.get(manifest.main);
  if (main === undefined) throw refused(`${manifest.main}, which the manifest names, is missing`);
  const kept = new Map<string, Buffer>([
    [MANIFEST_FILE, manifestBytes],
    [manifest.main, main],
  ]);
  for (const [name, bytes] of files) if (EXTRA_FILES.has(name)) kept.set(name, bytes);
  return { manifest, files: kept };
}

/**
 * Reads the plugin at `source`, a folder or a `.tgz`, into memory and checks its manifest. Nothing is
 * written.
 *
 * @throws WirebenchError `plugin-install-refused` | `plugin-manifest-invalid` | `plugin-api-mismatch`
 */
export async function stagePlugin(source: string): Promise<StagedPlugin> {
  const stat = await lstat(source).catch(() => undefined);
  if (stat === undefined) throw refused(`${source} does not exist`);
  if (stat.isSymbolicLink()) throw refused(`${source} is a symbolic link`);
  if (stat.isDirectory()) {
    const files = new Map<string, Buffer>();
    files.set(MANIFEST_FILE, await readRegular(join(source, MANIFEST_FILE)));
    const parsed = parsePluginManifest(files.get(MANIFEST_FILE)?.toString('utf8') ?? '');
    if (!parsed.ok) throw invalid(parsed.problems);
    files.set(parsed.manifest.main, await readRegular(join(source, parsed.manifest.main)));
    for (const name of EXTRA_FILES) {
      const extra = await lstat(join(source, name)).catch(() => undefined);
      if (extra?.isFile() === true) files.set(name, await readRegular(join(source, name)));
    }
    return staged(files);
  }
  if (!stat.isFile()) throw refused(`${source} is neither a folder nor a .tgz`);
  let entries: ReadonlyMap<string, Buffer>;
  try {
    entries = readTgz(await readFile(source));
  } catch (error) {
    if (error instanceof TarError) throw refused(`${source}: ${error.message}`);
    throw error;
  }
  return staged(withoutTopFolder(entries));
}

/** An archive packed with one top folder (`package/`, `acme/`) is read from inside it. */
function withoutTopFolder(entries: ReadonlyMap<string, Buffer>): ReadonlyMap<string, Buffer> {
  if (entries.has(MANIFEST_FILE)) return entries;
  const tops = new Set([...entries.keys()].map((name) => name.split('/')[0]));
  const [top] = tops;
  if (tops.size !== 1 || top === undefined || !entries.has(`${top}/${MANIFEST_FILE}`)) return entries;
  const inside = new Map<string, Buffer>();
  for (const [name, bytes] of entries) inside.set(name.slice(top.length + 1), bytes);
  return inside;
}

/** The lock, or an empty one when there is none. A lock that does not parse is treated as empty. */
export function readPluginLock(userData: string): PluginLock {
  let text: string;
  try {
    text = readFileSync(lockFileOf(userData), 'utf8');
  } catch {
    return { lockVersion: 1, plugins: {} };
  }
  try {
    const parsed = lockSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : { lockVersion: 1, plugins: {} };
  } catch {
    return { lockVersion: 1, plugins: {} };
  }
}

async function writePluginLock(userData: string, lock: PluginLock): Promise<void> {
  const file = lockFileOf(userData);
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, file);
}

/** The manifest of the plugin installed under `id`, if any; for a reinstall's "what changes". */
export function installedManifest(userData: string, id: string): PluginManifestData | undefined {
  try {
    const parsed = parsePluginManifest(readFileSync(join(pluginsDirOf(userData), id, MANIFEST_FILE), 'utf8'));
    return parsed.ok ? parsed.manifest : undefined;
  } catch {
    return undefined;
  }
}

/** Writes a staged plugin into place, replacing one of the same id, and records its hashes. */
export async function installStaged(userData: string, plugin: StagedPlugin, now: Date = new Date()): Promise<void> {
  const root = pluginsDirOf(userData);
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, '.staging-'));
  try {
    for (const [name, bytes] of plugin.files) await writeFile(join(staging, name), bytes, { flag: 'wx' });
    const target = join(root, plugin.manifest.id);
    const existing = await lstat(target).catch(() => undefined);
    if (existing !== undefined) {
      const old = join(root, `.old-${plugin.manifest.id}-${randomUUID()}`);
      await rename(target, old);
      await rename(staging, target);
      await rm(old, { recursive: true, force: true });
    } else {
      await rename(staging, target);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const lock = readPluginLock(userData);
  const manifestBytes = plugin.files.get(MANIFEST_FILE);
  const main = plugin.files.get(plugin.manifest.main);
  /* v8 ignore next -- staged() guarantees both */
  if (manifestBytes === undefined || main === undefined) throw refused('the plugin lost a file while installing');
  await writePluginLock(userData, {
    lockVersion: 1,
    plugins: {
      ...lock.plugins,
      [plugin.manifest.id]: {
        version: plugin.manifest.version,
        manifestSha256: sha256(manifestBytes),
        mainSha256: sha256(main),
        installedAt: now.toISOString(),
      },
    },
  });
}

/** @throws WirebenchError `plugin-missing` when nothing is installed under `id` */
export async function removePlugin(userData: string, id: string): Promise<void> {
  const lock = readPluginLock(userData);
  const dir = join(pluginsDirOf(userData), id);
  const present = /^[a-z0-9][a-z0-9-]{1,62}$/.test(id) && (await lstat(dir).catch(() => undefined)) !== undefined;
  if (!present && lock.plugins[id] === undefined) {
    throw new WirebenchError('plugin-missing', `No plugin "${id}" is installed`, { details: { id } });
  }
  if (present) await rm(dir, { recursive: true, force: true });
  const plugins = Object.fromEntries(Object.entries(lock.plugins).filter(([name]) => name !== id));
  await writePluginLock(userData, { lockVersion: 1, plugins });
}

/** One file of a plugin folder, read once without following a link, with its hash. */
function readPinned(path: string): { bytes: Buffer; sha256: string } {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > FILE_BYTES) throw new Error(`${path} is not a regular file of at most 16 MiB`);
    const bytes = readFileSync(fd);
    return { bytes, sha256: sha256(bytes) };
  } finally {
    closeSync(fd);
  }
}

/** Every installed plugin that still matches what was installed, and why each other one is skipped. */
export function loadInstalledPlugins(userData: string): {
  readonly plugins: readonly InstalledPlugin[];
  readonly problems: readonly PluginProblem[];
} {
  const root = pluginsDirOf(userData);
  let names: string[];
  try {
    names = readdirSync(root)
      .filter((name) => !name.startsWith('.'))
      .sort();
  } catch {
    return { plugins: [], problems: [] };
  }
  const lock = readPluginLock(userData);
  const plugins: InstalledPlugin[] = [];
  const problems: PluginProblem[] = [];
  for (const id of names) {
    const dir = join(root, id);
    const problem = (code: PluginProblemCode, message: string): void => {
      problems.push({ id, code, message });
    };
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      problem('plugin-not-installed', `${id} is not a plugin folder`);
      continue;
    }
    const entry = lock.plugins[id];
    if (entry === undefined) {
      problem('plugin-not-installed', `${id} was not installed with wirebench plugin install`);
      continue;
    }
    try {
      const manifestFile = readPinned(join(dir, MANIFEST_FILE));
      if (manifestFile.sha256 !== entry.manifestSha256) {
        problem('plugin-modified', `${id} changed since it was installed; install it again`);
        continue;
      }
      const parsed = parsePluginManifest(manifestFile.bytes.toString('utf8'));
      if (!parsed.ok || parsed.manifest.id !== id) {
        problem('plugin-manifest-invalid', `${id}'s manifest is not valid`);
        continue;
      }
      if (parsed.manifest.api !== PLUGIN_API_MAJOR) {
        problem('plugin-api-mismatch', `${id} is written for plugin API ${String(parsed.manifest.api)}`);
        continue;
      }
      const main = readPinned(join(dir, parsed.manifest.main));
      if (main.sha256 !== entry.mainSha256) {
        problem('plugin-modified', `${id} changed since it was installed; install it again`);
        continue;
      }
      plugins.push({ manifest: parsed.manifest, code: main.bytes.toString('utf8'), dir });
    } catch (error) {
      problem('plugin-modified', `${id} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { plugins, problems };
}
