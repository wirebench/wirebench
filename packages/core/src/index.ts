/**
 * The engine's core (package split spec §5): the protocol interface, the registry, the feature set,
 * the unions the protocols fill, the default-registry slot and the errors. Everything else is reached
 * by subpath (`@wirebench/core/<folder>/<file>`); `@wirebench/engine` composes the protocols over it.
 */
export * from './protocol/module.js';
export * from './protocol/registry.js';
export * from './protocol/features.js';
export * from './protocol/unions.js';
export * from './protocol/default-registry.js';
export * from './errors.js';
