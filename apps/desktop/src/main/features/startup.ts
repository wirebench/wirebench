/**
 * The feature switches this run starts with (phase 4 spec §4.2): the machine's preference
 * (`preferences.features`), resolved against every built-in descriptor, and the registry built
 * from it once. A workspace shared through Wirebench Server lays its team policy over that
 * ({@link FeaturesRun.forPolicy}, spec §6.2); a local workspace has none.
 *
 * `WIREBENCH_FEATURES` (`grpc=off,scripts=off`) is laid over the file's section only in an
 * unpackaged build, for development and e2e; in a shipped app an environment variable is the
 * person's own and could only say what the preference already can. It replaces the developer
 * switch `WIREBENCH_KINDS` of phase 3.
 */
import {
  BUILTIN_PROTOCOLS,
  builtinDescriptors,
  createBuiltinRegistry,
  nodeFs,
  resolveFeatures,
  type FeatureState,
  type FsLike,
  type Preferences,
  type ProtocolRegistry,
} from '@wirebench/engine';
import type { UnsupportedContainerWire } from '../../shared/wire-base.js';
import { KINDS, type KindId } from '../../shared/kinds/kind-module.js';
import { parseAreaSwitches } from '../areas.js';

/** The switches of one level resolved: what a workspace's project hosts and the renderer read. */
export interface ResolvedFeatures {
  readonly registry: ProtocolRegistry;
  readonly states: readonly FeatureState[];
  /** The protocol kinds that are on, in the kinds' order. */
  readonly enabledKinds: readonly KindId[];
  /** Every feature id that is on, protocols included. */
  readonly enabledFeatures: readonly string[];
}

/** This run's switches: the machine level, and the same with a workspace's team policy laid over. */
export interface FeaturesRun extends ResolvedFeatures {
  /** The preference the run started with, the variable laid over the file's section. */
  readonly preference: Readonly<Record<string, boolean>>;
  /** The machine level with `disabled` (a workspace's team policy, ADR-0029) laid over. Memoised per list. */
  forPolicy(disabled: readonly string[]): ResolvedFeatures;
}

/** `WIREBENCH_FEATURES="grpc=off,scripts=off"`, the grammar of `WIREBENCH_AREAS`; anything else is ignored. */
export function featureSwitchesFromEnv(env: NodeJS.ProcessEnv): Readonly<Record<string, boolean>> {
  return parseAreaSwitches(env['WIREBENCH_FEATURES']);
}

function resolve(preference: Readonly<Record<string, boolean>>, policy: readonly string[]): ResolvedFeatures {
  const { switches, states } = resolveFeatures(builtinDescriptors(), { preference, policy });
  const registry = createBuiltinRegistry(switches);
  return {
    registry,
    states,
    enabledKinds: KINDS.filter((kind) => registry.features.isEnabled(kind.feature.id)).map((kind) => kind.kind),
    enabledFeatures: states.filter((state) => state.enabled).map((state) => state.id),
  };
}

/**
 * Resolves the run's switches from the loaded preferences. Built once at start-up: a preference that
 * changes later applies at the next start, which the Settings row says.
 */
export function startupFeatures(input: {
  readonly preferences: Pick<Preferences, 'features'>;
  readonly env?: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
}): FeaturesRun {
  const preference: Readonly<Record<string, boolean>> = input.isPackaged
    ? input.preferences.features
    : { ...input.preferences.features, ...featureSwitchesFromEnv(input.env ?? {}) };
  const machine = resolve(preference, []);
  const byPolicy = new Map<string, ResolvedFeatures>();
  return {
    ...machine,
    preference,
    forPolicy(disabled) {
      if (disabled.length === 0) return machine;
      const key = [...new Set(disabled)].sort().join(',');
      let found = byPolicy.get(key);
      if (found === undefined) {
        found = resolve(preference, disabled);
        byPolicy.set(key, found);
      }
      return found;
    },
  };
}

/** The run every test and every caller without preferences gets: every feature at its default. */
export function defaultFeatures(env: NodeJS.ProcessEnv = {}): FeaturesRun {
  return startupFeatures({ preferences: { features: {} }, env, isPackaged: false });
}

/** What each kind keeps for the whole project rather than in a container, as the explorer names it. */
const PROJECT_FILES_NAME: Partial<Record<KindId, string>> = {
  rest: 'Webhooks',
  soap: 'WS-Security configurations',
};

/**
 * The project-level files (REST's `webhooks/`, SOAP's `wss/`) of each kind that is off, as placeholders:
 * the engine neither loads nor saves them, so they stay on disk as they are, and the explorer shows
 * one row per folder saying why rather than leaving them out unseen.
 */
export async function switchedOffProjectFiles(
  dir: string,
  enabled: readonly KindId[],
  fs: FsLike = nodeFs,
): Promise<UnsupportedContainerWire[]> {
  const placeholders: UnsupportedContainerWire[] = [];
  for (const module of BUILTIN_PROTOCOLS) {
    const kind = KINDS.find((candidate) => candidate.kind === module.kind)?.kind;
    if (kind === undefined || enabled.includes(kind) || module.projectFiles === undefined) continue;
    const files = await module.projectFiles.managed(fs, dir);
    const folders = [...new Set(files.map((file) => file.split('/')[0] ?? file))];
    const name = PROJECT_FILES_NAME[kind];
    for (const folder of folders) {
      placeholders.push({
        dir: folder,
        slug: folder,
        kind,
        reason: 'feature-disabled',
        ...(name !== undefined ? { name } : {}),
      });
    }
  }
  return placeholders;
}
