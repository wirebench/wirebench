/**
 * The composition file (spec §4.3): the one core file that imports every built-in protocol module.
 * It holds the built-in registry every entry point falls back to, and the union types a host that
 * narrows on `kind` uses.
 */
import type { GrpcCallResult } from './grpc/call.js';
import type { GrpcLiveEvent } from './grpc/events.js';
import { grpcProtocol } from './grpc/module.js';
import type { GrpcSelected } from './grpc/run.js';
import type { GrpcRequestSnapshot, GrpcResponseSnapshot } from './grpc/scripting.js';
import type { FeatureDescriptor } from './protocol/features.js';
import type { ProtocolModule } from './protocol/module.js';
import { createProtocolRegistry } from './protocol/registry.js';
import type { ProtocolRegistry } from './protocol/registry.js';
import { restProtocol } from './rest/module.js';
import type { RestSelected } from './rest/run.js';
import type { RestRequestSnapshot, RestResponseSnapshot } from './rest/scripting.js';
import type { RestLiveEvent } from './rest/events.js';
import type { RestExchange, RestSendInput } from './rest/send.js';
import { soapProtocol } from './soap/module.js';
import type { SoapSelected } from './soap/run.js';
import type { SoapRequestSnapshot, SoapResponseSnapshot } from './soap/scripting.js';
import type { SoapExchange, SoapSendInput } from './soap/types.js';
import { wsProtocol } from './ws/module.js';

/**
 * The four built-in protocols, in the order their containers tie-break in the explorer.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export const BUILTIN_PROTOCOLS: readonly ProtocolModule[] = [soapProtocol, restProtocol, grpcProtocol, wsProtocol];

/** The feature that switches request scripts (#63). Not a protocol, so the registry is told of it. */
export const SCRIPTS_FEATURE: FeatureDescriptor = {
  id: 'scripts',
  title: 'Scripts',
  default: true,
  stage: 'stable',
  requires: [],
};

/**
 * A registry of the built-in protocols and the `scripts` feature, with `switches` applied.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function createBuiltinRegistry(switches?: Readonly<Record<string, boolean>>): ProtocolRegistry {
  return createProtocolRegistry(BUILTIN_PROTOCOLS, {
    features: [SCRIPTS_FEATURE],
    ...(switches !== undefined ? { switches } : {}),
  });
}

let builtin: ProtocolRegistry | undefined;

/**
 * The registry an entry point uses when its caller passes none: the built-in protocols with every
 * feature on. Created on first use and kept. Call it inside a function, never at module scope: the
 * modules import core files that import this one.
 */
export function defaultRegistry(): ProtocolRegistry {
  builtin ??= createBuiltinRegistry();
  return builtin;
}

/** One saved request selected for a run, of any built-in protocol a run can send. */
export type SelectedRequest = SoapSelected | RestSelected | GrpcSelected;

/** The exchange a request travelled as, for a host that keeps more of it than a report does. */
export type SentExchange =
  | {
      readonly kind: 'soap';
      readonly soap: SoapExchange;
      /** The request as resolved: references unexpanded, before its script and its credentials. */
      readonly input: SoapSendInput;
    }
  | {
      readonly kind: 'rest';
      readonly rest: RestExchange;
      /** What was sent: after the script, with the credentials resolved. */
      readonly input: RestSendInput;
      readonly contract?: unknown;
    }
  | {
      readonly kind: 'grpc';
      /** The call whole: every request message as sent, every response message decoded. */
      readonly grpc: GrpcCallResult;
    };

/** A message an open exchange reports, whatever its protocol; Task 12 adds WebSocket. */
export type LiveEvent = RestLiveEvent | GrpcLiveEvent;

/** The request snapshot of any built-in protocol that has scripts (spec §3.1). */
export type RequestSnapshot = RestRequestSnapshot | SoapRequestSnapshot | GrpcRequestSnapshot;

/** The response snapshot of any built-in protocol that has scripts (spec §3.1). */
export type ResponseSnapshot = RestResponseSnapshot | SoapResponseSnapshot | GrpcResponseSnapshot;
