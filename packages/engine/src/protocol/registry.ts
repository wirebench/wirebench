/** The modules a host composed, with its feature set (spec §4.2). */
import { ProjectError, WirebenchError } from '../errors.js';
import { createFeatureSet } from './features.js';
import type { FeatureDescriptor, FeatureSet } from './features.js';
import type { ProtocolModule } from './module.js';

/** The modules of one host. */
export interface ProtocolRegistry {
  readonly features: FeatureSet;
  /** The enabled modules, in registration order. */
  readonly modules: readonly ProtocolModule[];
  status(kind: string): 'enabled' | 'disabled' | 'unknown';
  /** The enabled module for `kind`, or undefined. */
  find(kind: string): ProtocolModule | undefined;
  /** @throws WirebenchError `feature-disabled` | ProjectError `project-kind-not-supported` */
  require(kind: string): ProtocolModule;
}

/** What a registry is built with besides its modules. */
export interface ProtocolRegistryOptions {
  /** Descriptors for features that are not protocols (`scripts`). */
  readonly features?: readonly FeatureDescriptor[];
  readonly switches?: Readonly<Record<string, boolean>>;
}

/**
 * The error for using a feature that is off: a WirebenchError `feature-disabled` with
 * `details.feature`, and `details.requires` when a required feature is what is off.
 */
export function featureDisabled(features: FeatureSet, id: string): WirebenchError {
  const why = features.whyDisabled(id);
  const title = features.descriptors.find((descriptor) => descriptor.id === id)?.title ?? id;
  return new WirebenchError(
    'feature-disabled',
    why?.by === 'requires' ? `${title} is off because "${why.feature}" is off` : `${title} is switched off`,
    { details: { feature: id, ...(why?.by === 'requires' ? { requires: why.feature } : {}) } },
  );
}

/**
 * Builds a registry from `modules`. Its feature set is the modules' descriptors plus
 * `options.features`, with `options.switches` applied.
 *
 * @throws Error for two modules of one kind; what `createFeatureSet` throws
 */
export function createProtocolRegistry(
  modules: readonly ProtocolModule[],
  options: ProtocolRegistryOptions = {},
): ProtocolRegistry {
  const byKind = new Map<string, ProtocolModule>();
  for (const module of modules) {
    if (byKind.has(module.kind)) {
      throw new Error(`createProtocolRegistry: two modules for "${module.kind}"`);
    }
    byKind.set(module.kind, module);
  }
  const features = createFeatureSet(
    [...modules.map((module) => module.feature), ...(options.features ?? [])],
    options.switches,
  );
  const status = (kind: string): 'enabled' | 'disabled' | 'unknown' =>
    !byKind.has(kind) ? 'unknown' : features.isEnabled(kind) ? 'enabled' : 'disabled';
  const find = (kind: string): ProtocolModule | undefined =>
    status(kind) === 'enabled' ? byKind.get(kind) : undefined;
  return {
    features,
    modules: modules.filter((module) => features.isEnabled(module.kind)),
    status,
    find,
    require(kind) {
      const found = find(kind);
      if (found !== undefined) return found;
      if (status(kind) === 'disabled') throw featureDisabled(features, kind);
      throw new ProjectError('project-kind-not-supported', `This build has no "${kind}" protocol`, {
        details: { kind, supported: [...byKind.keys()] },
      });
    },
  };
}
