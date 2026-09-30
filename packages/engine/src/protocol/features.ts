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
