/** Finds the scripting facet of a protocol (spec §5.5). */
import { WirebenchError } from '../errors.js';
import type { ProtocolScripting } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';

/** The scripting facet of `protocol` in `registry` (the built-in one when absent), if it has one. */
export function scriptingOf(
  protocol: string,
  registry: ProtocolRegistry = defaultRegistry(),
): ProtocolScripting | undefined {
  return registry.find(protocol)?.scripting;
}

/**
 * A facet as given, or the facet of the protocol a `kind` names.
 *
 * @throws WirebenchError `script-unsupported` when the protocol has no scripting facet
 */
export function requireScripting(
  scripting: ProtocolScripting | string,
  registry?: ProtocolRegistry,
): ProtocolScripting {
  if (typeof scripting !== 'string') return scripting;
  const found = scriptingOf(scripting, registry);
  if (found === undefined) {
    throw new WirebenchError('script-unsupported', `Requests of the "${scripting}" protocol cannot have scripts`, {
      details: { protocol: scripting },
    });
  }
  return found;
}
