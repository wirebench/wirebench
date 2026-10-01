/**
 * Opening and resolving one send through a protocol's run facet (spec §3.2). Apart from
 * `exchange.ts` because it reads the built-in registry, whose modules build their handles there.
 */
import type { ProtocolRun, RunScope } from '../protocol/module.js';
import { defaultRegistry } from '../protocols.js';
import type { SelectedRequest } from '../protocols.js';
import type { ExchangeHandle, ExchangeOptions } from './exchange.js';
import type { SendHost } from './host.js';

function runFacet(item: SelectedRequest, scope: RunScope): ProtocolRun {
  const registry = scope.context.registry ?? defaultRegistry();
  const run = registry.require(item.kind).run;
  if (run === undefined) throw new Error(`The "${item.kind}" protocol cannot run requests`);
  return run;
}

/** Opens one send of `item` through its protocol's run facet (spec §3.2). */
export function openExchange(item: SelectedRequest, host: SendHost, options: ExchangeOptions): ExchangeHandle {
  return runFacet(item, options.scope).open(item, options.scope, host, options);
}

/** What a send of `item` would send, resolved and not connected (spec §3.3). */
export function resolveExchange(item: SelectedRequest, host: SendHost, scope: RunScope): Promise<unknown> {
  return runFacet(item, scope).resolve(item, scope, host);
}
