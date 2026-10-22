/**
 * Features: what a host can switch off (spec §4.1). Every protocol is one; `scripts` is the first
 * that is not. A feature set is immutable: a host that changes a switch creates a new set.
 */

/**
 * One switchable feature.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface FeatureDescriptor {
  readonly id: string;
  readonly title: string;
  /** Whether the feature is on when no switch names it. */
  readonly default: boolean;
  readonly stage: 'stable' | 'experimental';
  /** Features that must be on for this one to be on. */
  readonly requires: readonly string[];
}

/**
 * Why a feature is off.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export type WhyDisabled =
  { readonly by: 'switch' } | { readonly by: 'requires'; readonly feature: string } | { readonly by: 'unknown' };

/**
 * The features of one host, with its switches applied.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface FeatureSet {
  readonly descriptors: readonly FeatureDescriptor[];
  isEnabled(id: string): boolean;
  /** Undefined when the feature is on. */
  whyDisabled(id: string): WhyDisabled | undefined;
}

function assertNoCycle(byId: ReadonlyMap<string, FeatureDescriptor>): void {
  const done = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (path.includes(id)) {
      throw new Error(`createFeatureSet: "requires" cycle: ${[...path, id].join(' -> ')}`);
    }
    if (done.has(id)) return;
    for (const required of byId.get(id)?.requires ?? []) {
      visit(required, [...path, id]);
    }
    done.add(id);
  };
  for (const id of byId.keys()) visit(id, []);
}

/**
 * Builds a feature set. A feature is on when its switch says so (its `default` when no switch
 * names it) and every feature it requires is on. A switch for an id with no descriptor is ignored:
 * it may belong to a module this build does not have.
 *
 * @throws Error for a duplicate id or a `requires` cycle; both are programming errors
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function createFeatureSet(
  descriptors: readonly FeatureDescriptor[],
  switches: Readonly<Record<string, boolean>> = {},
): FeatureSet {
  const byId = new Map<string, FeatureDescriptor>();
  for (const descriptor of descriptors) {
    if (byId.has(descriptor.id)) {
      throw new Error(`createFeatureSet: duplicate feature "${descriptor.id}"`);
    }
    byId.set(descriptor.id, descriptor);
  }
  assertNoCycle(byId);

  const why = new Map<string, WhyDisabled | undefined>();
  const resolve = (id: string): WhyDisabled | undefined => {
    if (why.has(id)) return why.get(id);
    const descriptor = byId.get(id);
    let result: WhyDisabled | undefined;
    if (descriptor === undefined) {
      result = { by: 'unknown' };
    } else if (!(switches[id] ?? descriptor.default)) {
      result = { by: 'switch' };
    } else {
      const blocked = descriptor.requires.find((required) => resolve(required) !== undefined);
      result = blocked !== undefined ? { by: 'requires', feature: blocked } : undefined;
    }
    why.set(id, result);
    return result;
  };
  for (const id of byId.keys()) resolve(id);

  return {
    descriptors: [...byId.values()],
    isEnabled: (id) => resolve(id) === undefined,
    whyDisabled: (id) => resolve(id),
  };
}

/**
 * Why a feature is off after the three levels are resolved (phase 4 spec §3).
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export type FeatureReason =
  | { readonly by: 'policy' }
  | { readonly by: 'preference' }
  | { readonly by: 'default' }
  | { readonly by: 'requires'; readonly feature: string };

/**
 * One feature with the three levels applied: what each level said, and what came of it. The rows a
 * Settings screen or a `--features` listing shows.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface FeatureState {
  readonly id: string;
  readonly title: string;
  readonly stage: 'stable' | 'experimental';
  readonly requires: readonly string[];
  readonly default: boolean;
  /** What the preference says, when it names the feature. */
  readonly preference?: boolean;
  /** The policy names it off. */
  readonly policy: boolean;
  /** On or off after precedence and `requires`. */
  readonly enabled: boolean;
  /** Why it is off; undefined when on. */
  readonly reason?: FeatureReason;
}

/**
 * The three levels, as a host holds them (phase 4 spec §3). Both are optional: a process with no
 * preferences file and no workspace passes nothing and gets the defaults.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface FeatureLevels {
  /** Ids a team policy switches off. It can only restrict (ADR-0029). */
  readonly policy?: readonly string[];
  /** The person's own switches, by id. */
  readonly preference?: Readonly<Record<string, boolean>>;
}

/**
 * Resolves the levels for `descriptors`: the policy, when it names an id, wins and the feature is
 * off; else the preference, when it names it; else the descriptor's default. Then `requires`
 * applies as {@link createFeatureSet} applies it. An id a level names that has no descriptor is
 * ignored: it may belong to a module this build does not have.
 *
 * @returns the switches a registry is built with, and one row per descriptor in their order
 * @throws Error for what `createFeatureSet` throws
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function resolveFeatures(
  descriptors: readonly FeatureDescriptor[],
  levels: FeatureLevels = {},
): { readonly switches: Readonly<Record<string, boolean>>; readonly states: readonly FeatureState[] } {
  const policy = new Set(levels.policy ?? []);
  const preference = levels.preference ?? {};
  const switches: Record<string, boolean> = {};
  for (const descriptor of descriptors) {
    // `hasOwn`: a preference key such as `constructor` must not read Object.prototype.
    const preferred = Object.hasOwn(preference, descriptor.id) ? preference[descriptor.id] : undefined;
    switches[descriptor.id] = policy.has(descriptor.id) ? false : (preferred ?? descriptor.default);
  }
  const set = createFeatureSet(descriptors, switches);
  const states = set.descriptors.map((descriptor): FeatureState => {
    const why = set.whyDisabled(descriptor.id);
    const preferred = Object.hasOwn(preference, descriptor.id) ? preference[descriptor.id] : undefined;
    let reason: FeatureReason | undefined;
    if (why?.by === 'requires') {
      reason = { by: 'requires', feature: why.feature };
    } else if (why !== undefined) {
      reason = policy.has(descriptor.id)
        ? { by: 'policy' }
        : preferred !== undefined
          ? { by: 'preference' }
          : { by: 'default' };
    }
    return {
      id: descriptor.id,
      title: descriptor.title,
      stage: descriptor.stage,
      requires: descriptor.requires,
      default: descriptor.default,
      ...(preferred !== undefined ? { preference: preferred } : {}),
      policy: policy.has(descriptor.id),
      enabled: why === undefined,
      ...(reason !== undefined ? { reason } : {}),
    };
  });
  return { switches, states };
}
