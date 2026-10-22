/**
 * The registry an entry point uses when its caller passes none (package split spec §3.3). Core holds
 * the slot; the composition (`protocols.ts`, which `@wirebench/engine` loads) installs the built-in
 * registry with every feature on, so a caller that passes no registry gets what it always got. A host
 * that switches protocols off passes its own registry to each call, as before.
 *
 * Nothing installed means core was loaded without its composition: a test importing one source file,
 * or a host of a protocol package that composed nothing. That is a programming error, reported as one.
 */
import { WirebenchError } from '../errors.js';
import type { ProtocolRegistry } from './registry.js';

let create: (() => ProtocolRegistry) | undefined;
let installed: ProtocolRegistry | undefined;

/**
 * Names the registry {@link defaultRegistry} answers with. Called once, by the composition, when it
 * loads; `create` runs on the first call of `defaultRegistry()`, never at module scope, since the
 * modules it composes import core files that import this one.
 */
export function installDefaultRegistry(factory: () => ProtocolRegistry): void {
  create = factory;
  installed = undefined;
}

/** The registry an entry point falls back to: the built-in protocols with every feature on. */
export function defaultRegistry(): ProtocolRegistry {
  if (installed !== undefined) {
    return installed;
  }
  if (create === undefined) {
    throw new WirebenchError(
      'registry-missing',
      'No protocol registry is composed: load @wirebench/engine, or pass a registry to this call',
    );
  }
  installed = create();
  return installed;
}
