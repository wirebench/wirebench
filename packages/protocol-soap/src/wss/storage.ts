/**
 * The WS-Security configurations on disk (spec §3): one file each under `wss/outgoing/` and
 * `wss/incoming/`, kept verbatim so a field written by a later build survives a save. SOAP's
 * project-level files: with SOAP off they are not read, and a save leaves them as they are.
 * `wss/keystores.yaml` is core's (`project/serialize.ts`).
 */
import type { ProtocolProjectFiles } from '#core/protocol/module';
import type { FsLike } from '#core/project/fs';
import { readdirIfExists } from '#core/project/fs';
import { abs, readYaml } from '#core/project/load-helpers';
import type { WssRef } from '#core/project/model';
import { assertWssRelativePath, slugify, WSS_DIR } from '#core/project/paths';
import { parseFile } from '#core/project/schema-parts';
import { wssIncomingFileSchema, wssOutgoingFileSchema } from '#core/project/schema';
import { stringifyYaml } from '#core/project/yaml';
import type { WssConfigs } from './project.js';
import { wssConfigsOf, withWssConfigs } from './project.js';

type Direction = keyof WssConfigs;

const DIRECTIONS: readonly Direction[] = ['outgoing', 'incoming'];

/**
 * Relative path of a WS-Security configuration file.
 *
 * @throws ProjectError `project-path-invalid` when `ref.file` is not a
 * relative path rooted at `wss/` with only safe segments.
 */
export function wssRefPath(direction: Direction, ref: WssRef): string {
  if (ref.file !== undefined) {
    assertWssRelativePath(ref.file);
    return ref.file;
  }
  return `${WSS_DIR}/${direction}/${slugify(ref.name)}.yaml`;
}

/** The `.yaml` files of `wss/<direction>/`, relative to the project root. */
async function directoryFiles(fs: FsLike, root: string, direction: Direction): Promise<string[]> {
  const dir = `${WSS_DIR}/${direction}`;
  return (await readdirIfExists(fs, abs(root, dir)))
    .filter((entry) => entry.isFile && entry.name.endsWith('.yaml'))
    .map((entry) => `${dir}/${entry.name}`);
}

/** Every string in `value` passed through `mapId`, arrays and nested objects included. */
function remapValue(value: unknown, mapId: (id: string) => string): unknown {
  if (typeof value === 'string') return mapId(value);
  if (Array.isArray(value)) return value.map((item) => remapValue(item, mapId));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, remapValue(item, mapId)]),
    );
  }
  return value;
}

/** SOAP's project-level files: the WS-Security outgoing and incoming configurations. */
export const wssProjectFiles: ProtocolProjectFiles = {
  async load({ fs, root }, project) {
    const configs: Record<Direction, WssRef[]> = { outgoing: [], incoming: [] };
    for (const direction of DIRECTIONS) {
      const schema = direction === 'outgoing' ? wssOutgoingFileSchema : wssIncomingFileSchema;
      for (const relative of await directoryFiles(fs, root, direction)) {
        const parsed = parseFile(schema, await readYaml(fs, root, relative), relative);
        configs[direction].push({ id: parsed.id, name: parsed.name, file: relative, document: parsed });
      }
      configs[direction].sort((a, b) => a.name.localeCompare(b.name));
    }
    return withWssConfigs(project, configs);
  },

  files(project) {
    const files = new Map<string, string>();
    const configs = wssConfigsOf(project);
    for (const direction of DIRECTIONS) {
      for (const ref of configs[direction]) files.set(wssRefPath(direction, ref), stringifyYaml(ref.document));
    }
    return files;
  },

  async managed(fs, root) {
    return [...(await directoryFiles(fs, root, 'outgoing')), ...(await directoryFiles(fs, root, 'incoming'))];
  },

  entityIds(project) {
    const { outgoing, incoming } = wssConfigsOf(project);
    return [...outgoing, ...incoming].map((ref) => ref.id);
  },

  /** Every id inside a configuration's document is passed through too: an entry may name another entity. */
  withEntityIds(project, mapId) {
    const mapRef = (ref: WssRef): WssRef => ({
      ...ref,
      id: mapId(ref.id),
      document: remapValue(ref.document, mapId) as Readonly<Record<string, unknown>>,
    });
    const { outgoing, incoming } = wssConfigsOf(project);
    return withWssConfigs(project, { outgoing: outgoing.map(mapRef), incoming: incoming.map(mapRef) });
  },
};
