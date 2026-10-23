/**
 * Feature switches for one CLI process (feature switches phase 4 spec §5.1): `--features <list>` laid
 * over `WIREBENCH_FEATURES` per id, both in the `WIREBENCH_AREAS` grammar (`id=on|off`, comma
 * separated, case-insensitive, spaces trimmed). The CLI has no preferences file and no workspace
 * policy, so the parsed switches are the one level it resolves.
 */
import { homedir } from 'node:os';
import {
  appendPluginNetRecord,
  builtinDescriptors,
  createBuiltinRegistry,
  createPluginHost,
  loadInstalledPlugins,
} from '@wirebench/engine';
import type { PluginHost, ProtocolRegistry } from '@wirebench/engine';
import { defaultHistoryDir, defaultUserDataDir } from './ops/paths.js';
import { proxyFromEnv } from './proxy-env.js';
import { CLI_REPORTERS } from './reporters/builtins.js';
import { UsageError } from './usage-error.js';

/** The environment variable every verb reads. */
export const FEATURES_VARIABLE = 'WIREBENCH_FEATURES';

/** Set to `off` to load no plugin, as `--no-plugins` does (ADR-0031). */
export const PLUGINS_VARIABLE = 'WIREBENCH_PLUGINS';

/** What `--features` adds to a parsed verb; present on every verb, so a pipeline can set it anywhere. */
export interface FeatureArgs {
  /** `--features <list>`, as typed. */
  readonly features?: string;
  /** `--no-plugins`: load no installed plugin in this process. */
  readonly noPlugins?: true;
}

/** One `id=on|off` entry; `undefined` for a blank one, `null` for a malformed one. */
function parseEntry(entry: string): { readonly id: string; readonly on: boolean } | undefined | null {
  if (entry.trim() === '') return undefined;
  const [id, state, ...more] = entry.split('=').map((part) => part.trim().toLowerCase());
  if (id === undefined || id === '' || more.length > 0 || (state !== 'on' && state !== 'off')) return null;
  return { id, on: state === 'on' };
}

/**
 * The switches the flag and the variable name, the flag winning per id. A malformed flag entry is a
 * usage error; a malformed variable entry is ignored (the variable is set once for many commands
 * and must not break a verb that does not care). An id with no built-in descriptor is dropped
 * after one `unknown feature "x" ignored` warning, so a variable set for a newer version does not
 * break an older one.
 *
 * @throws UsageError for a flag entry that is not `id=on|off`
 */
export function parseFeatureSwitches(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
): Record<string, boolean> {
  const switches: Record<string, boolean> = {};
  for (const entry of (env[FEATURES_VARIABLE] ?? '').split(',')) {
    const parsed = parseEntry(entry);
    if (parsed !== undefined && parsed !== null) switches[parsed.id] = parsed.on;
  }
  for (const entry of (flag ?? '').split(',')) {
    const parsed = parseEntry(entry);
    if (parsed === null) {
      throw new UsageError(`--features takes a comma-separated list of <id>=on|off, got "${entry.trim()}"`);
    }
    if (parsed !== undefined) switches[parsed.id] = parsed.on;
  }
  const known = new Set(builtinDescriptors().map((descriptor) => descriptor.id));
  for (const id of Object.keys(switches)) {
    // A plugin's switch is known only once its plugin is loaded; an absent one restricts nothing.
    if (!known.has(id) && !id.startsWith('plugin:')) {
      warn(`unknown feature "${id}" ignored`);
      delete switches[id];
    }
  }
  return switches;
}

/** The plugins this process loaded, once: the stderr line about them is written once too. */
let pluginHost: PluginHost | undefined;

/**
 * The installed plugins, loaded from the per-user folder the desktop shares (`<userData>/plugins`,
 * spec §6) the first time a verb that uses them asks. No flag or variable points elsewhere; turning
 * plugins off always works. Each one loaded is named on stderr with the origins it may reach, and
 * each one skipped with why.
 */
export function cliPluginHost(io: {
  readonly stderr: NodeJS.WritableStream;
  readonly env: NodeJS.ProcessEnv;
}): PluginHost {
  if (pluginHost !== undefined) return pluginHost;
  const home = homedir();
  const { plugins, problems } = loadInstalledPlugins(defaultUserDataDir(process.platform, io.env, home));
  for (const plugin of plugins) {
    const origins = plugin.manifest.capabilities?.network ?? [];
    io.stderr.write(
      `plugin: ${plugin.manifest.id} ${plugin.manifest.version}${origins.length > 0 ? ` (network: ${origins.join(', ')})` : ''}\n`,
    );
  }
  for (const problem of problems) io.stderr.write(`warning: plugin ${problem.id} skipped: ${problem.message}\n`);
  const proxyFor = proxyFromEnv(io.env);
  const historyDir = defaultHistoryDir(process.platform, io.env, home);
  pluginHost = createPluginHost(plugins, {
    network: (url) => {
      const proxy = proxyFor(url);
      return Promise.resolve(proxy !== undefined ? { proxy } : {});
    },
    record: (entry) => {
      void appendPluginNetRecord(historyDir, entry);
    },
    log: (plugin, line) => io.stderr.write(`plugin ${plugin}: ${line}\n`),
  });
  return pluginHost;
}

/** Stops the plugin sandbox this process started, if any, so the process can exit. */
export async function disposeCliPluginHost(): Promise<void> {
  const host = pluginHost;
  pluginHost = undefined;
  await host?.dispose();
}

/**
 * The registry a verb runs with: the built-in protocols and features, with `switches` applied (the
 * preference level; the CLI has no policy, so there is nothing else to resolve), and the CLI's own
 * reporters beside the engine's.
 */
export function registryFor(switches: Readonly<Record<string, boolean>>, plugins?: PluginHost): ProtocolRegistry {
  const contributions = plugins?.contributions;
  return createBuiltinRegistry(
    switches,
    { ...contributions, reporters: [...CLI_REPORTERS, ...(contributions?.reporters ?? [])] },
    plugins?.features ?? [],
  );
}

/**
 * The registry for one verb's process, from its `--features` and the environment it runs in; each
 * unknown id is warned about on stderr, once.
 */
export function featuresFor(
  args: FeatureArgs,
  io: { readonly stderr: NodeJS.WritableStream; readonly env: NodeJS.ProcessEnv },
  options: { readonly plugins?: boolean } = {},
): ProtocolRegistry {
  const switches = parseFeatureSwitches(args.features, io.env, (line) => io.stderr.write(`warning: ${line}\n`));
  const off = args.noPlugins === true || io.env[PLUGINS_VARIABLE]?.trim().toLowerCase() === 'off';
  if (off) switches['plugins'] = false;
  const load = options.plugins === true && switches['plugins'] !== false;
  return registryFor(switches, load ? cliPluginHost(io) : undefined);
}
