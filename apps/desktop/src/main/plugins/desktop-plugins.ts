/**
 * This run's plugins (phase 7 spec §6, §9; ADR-0031): loaded once at start-up from
 * `<userData>/plugins/`, the folder the CLI shares, and composed into the start-up registry. Settings
 * → Plugins lists them, installs one from a path the person just picked (read in memory, shown, then
 * written on a second, explicit call) and removes one; either applies at the next start.
 *
 * Nothing here is reachable from a project: no project file names a plugin folder, and the folder is
 * the app's own data folder.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  appendPluginNetRecord,
  createPluginHost,
  installedManifest,
  installStaged,
  loadInstalledPlugins,
  readPluginLock,
  removePlugin,
  stagePlugin,
  WirebenchError,
  type PluginHost,
  type PluginHostOptions,
  type PluginManifestData,
  type PluginProblem,
  type StagedPlugin,
} from '@wirebench/engine';
import type { PluginRowWire, PluginsListResponse, PluginsStageResponse } from '../../shared/plugins-wire.js';

export interface DesktopPlugins {
  /** The loaded plugins' contributions and switches; undefined when the `plugins` switch is off. */
  readonly host: PluginHost | undefined;
  list(): PluginsListResponse;
  /** @throws WirebenchError `plugin-install-refused` | `plugin-manifest-invalid` | `plugin-api-mismatch` */
  stage(path: string): Promise<PluginsStageResponse>;
  /** @throws WirebenchError `plugin-install-refused` for a token that is not one `stage` handed out */
  install(token: string): Promise<{ readonly id: string }>;
  /** @throws WirebenchError `plugin-missing` */
  remove(id: string): Promise<void>;
  dispose(): Promise<void>;
}

export function pluginRow(
  manifest: PluginManifestData,
  extra: { installedAt?: string; loaded: boolean },
): PluginRowWire {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    importers: (manifest.contributes.importers ?? []).map((entry) => ({
      id: `${manifest.id}/${entry.id}`,
      title: entry.title,
      extensions: [...(entry.extensions ?? [])],
    })),
    reporters: (manifest.contributes.reporters ?? []).map((entry) => ({
      id: `${manifest.id}/${entry.id}`,
      title: entry.title,
      extension: entry.extension,
    })),
    codeGenerators: (manifest.contributes.codeGenerators ?? []).map((entry) => ({
      id: `${manifest.id}/${entry.id}`,
      title: entry.title,
      language: entry.language,
    })),
    network: [...(manifest.capabilities?.network ?? [])],
    ...(extra.installedAt !== undefined ? { installedAt: extra.installedAt } : {}),
    loaded: extra.loaded,
  };
}

/** How many staged plugins main holds at once; an older one is dropped. */
const STAGED_LIMIT = 4;

export function loadDesktopPlugins(input: {
  readonly userData: string;
  /** The `plugins` switch is off by the preference: nothing is loaded. */
  readonly off: boolean;
  readonly network?: PluginHostOptions['network'];
  readonly log?: (plugin: string, line: string) => void;
}): DesktopPlugins {
  const { userData } = input;
  const historyDir = join(userData, 'history');
  let host: PluginHost | undefined;
  let loadedIds = new Set<string>();
  let problems: readonly PluginProblem[] = [];
  if (!input.off) {
    const loaded = loadInstalledPlugins(userData);
    problems = loaded.problems;
    loadedIds = new Set(loaded.plugins.map((plugin) => plugin.manifest.id));
    host = createPluginHost(loaded.plugins, {
      ...(input.network !== undefined ? { network: input.network } : {}),
      record: (entry) => {
        void appendPluginNetRecord(historyDir, entry);
      },
      ...(input.log !== undefined ? { log: input.log } : {}),
    });
  }
  const staged = new Map<string, StagedPlugin>();

  const rowOf = (id: string): PluginRowWire | undefined => {
    const manifest = installedManifest(userData, id);
    if (manifest === undefined) return undefined;
    const installedAt = readPluginLock(userData).plugins[id]?.installedAt;
    return pluginRow(manifest, { ...(installedAt !== undefined ? { installedAt } : {}), loaded: loadedIds.has(id) });
  };

  return {
    host,
    list() {
      // Read again, so a plugin installed or removed since start-up shows as it now is.
      const now = loadInstalledPlugins(userData);
      const lock = readPluginLock(userData);
      return {
        plugins: now.plugins.map((plugin) => {
          const installedAt = lock.plugins[plugin.manifest.id]?.installedAt;
          return pluginRow(plugin.manifest, {
            ...(installedAt !== undefined ? { installedAt } : {}),
            loaded: loadedIds.has(plugin.manifest.id),
          });
        }),
        skipped: (input.off
          ? now.problems
          : [...new Map([...problems, ...now.problems].map((p) => [p.id, p])).values()]
        ).map((problem) => ({ id: problem.id, code: problem.code, message: problem.message })),
        off: input.off,
      };
    },
    async stage(path) {
      const plugin = await stagePlugin(path);
      const token = randomUUID();
      staged.set(token, plugin);
      for (const key of [...staged.keys()].slice(0, Math.max(0, staged.size - STAGED_LIMIT))) staged.delete(key);
      const replaces = rowOf(plugin.manifest.id);
      return {
        token,
        plugin: pluginRow(plugin.manifest, { loaded: false }),
        ...(replaces !== undefined ? { replaces } : {}),
      };
    },
    async install(token) {
      const plugin = staged.get(token);
      if (plugin === undefined) {
        throw new WirebenchError('plugin-install-refused', 'That plugin is no longer ready to install; pick it again');
      }
      staged.delete(token);
      await installStaged(userData, plugin);
      return { id: plugin.manifest.id };
    },
    remove: (id) => removePlugin(userData, id),
    dispose: async () => {
      await host?.dispose();
    },
  };
}
