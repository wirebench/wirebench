/**
 * The composition file (spec §4.3): the one core file that imports every built-in protocol module.
 * It holds the built-in registry every entry point falls back to, and the union types a host that
 * narrows on `kind` uses.
 */
import type { GrpcCallResult } from './grpc/call.js';
import type { GrpcRequestDef } from './grpc/model.js';
import type { GrpcLiveEvent } from './grpc/events.js';
import { grpcProtocol } from './grpc/module.js';
import type { GrpcResolvedInput, GrpcSelected } from './grpc/run.js';
import type { GrpcRequestSnapshot, GrpcResponseSnapshot } from './grpc/scripting.js';
import type { McpLiveEvent } from './mcp/events.js';
import type { McpExchange } from './mcp/exchange.js';
import type { McpRequestDef } from './mcp/model.js';
import { mcpProtocol } from './mcp/module.js';
import type { McpSelected } from './mcp/run.js';
import type { McpRequestSnapshot, McpResponseSnapshot } from './mcp/scripting.js';
import type { FeatureDescriptor } from './protocol/features.js';
import type { ProtocolModule } from './protocol/module.js';
import { createProtocolRegistry } from './protocol/registry.js';
import type { ProtocolRegistry } from './protocol/registry.js';
import type { GraphqlCheckResult } from './rest/graphql/check.js';
import type { RestRequestDef } from './rest/model.js';
import { restProtocol } from './rest/module.js';
import type { RestSelected } from './rest/run.js';
import type { RestRequestSnapshot, RestResponseSnapshot } from './rest/scripting.js';
import type { RestLiveEvent } from './rest/events.js';
import type { RestExchange, RestSendInput } from './rest/send.js';
import type { SoapRequestDef } from './soap/model.js';
import { soapProtocol } from './soap/module.js';
import type { SoapSelected } from './soap/run.js';
import type { SoapRequestSnapshot, SoapResponseSnapshot } from './soap/scripting.js';
import type { SoapExchange, SoapSendInput, WsdlImportResult } from './soap/types.js';
import type { WsLiveEvent } from './ws/events.js';
import type { WsExchange, WsRequestDef } from './ws/model.js';
import { wsProtocol } from './ws/module.js';
import type { WsSelected } from './ws/run.js';

/**
 * The five built-in protocols, in the order their containers tie-break in the explorer.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export const BUILTIN_PROTOCOLS: readonly ProtocolModule[] = [
  soapProtocol,
  restProtocol,
  grpcProtocol,
  wsProtocol,
  mcpProtocol,
];

/** The feature that switches request scripts (#63). Not a protocol, so the registry is told of it. */
export const SCRIPTS_FEATURE: FeatureDescriptor = {
  id: 'scripts',
  title: 'Scripts',
  default: true,
  stage: 'stable',
  requires: [],
};

/**
 * The switchable features that are not protocols (phase 4 spec §2), in the order Settings lists
 * them: automation first, then what needs a server. `scripts` is {@link SCRIPTS_FEATURE}.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export const BUILTIN_FEATURES: readonly FeatureDescriptor[] = [
  SCRIPTS_FEATURE,
  { id: 'sequences', title: 'Sequences', default: true, stage: 'stable', requires: [] },
  { id: 'webhooks', title: 'Webhooks', default: true, stage: 'stable', requires: ['rest'] },
  { id: 'server-sync', title: 'Shared workspaces', default: true, stage: 'stable', requires: [] },
  { id: 'team-secrets', title: 'Team secrets', default: true, stage: 'stable', requires: ['server-sync'] },
  { id: 'mcp-server', title: 'MCP server', default: true, stage: 'stable', requires: [] },
];

/** Every built-in descriptor: the protocols' own, then {@link BUILTIN_FEATURES}. */
export function builtinDescriptors(): readonly FeatureDescriptor[] {
  return [...BUILTIN_PROTOCOLS.map((module) => module.feature), ...BUILTIN_FEATURES];
}

/**
 * A registry of the built-in protocols and {@link BUILTIN_FEATURES}, with `switches` applied.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function createBuiltinRegistry(switches?: Readonly<Record<string, boolean>>): ProtocolRegistry {
  return createProtocolRegistry(BUILTIN_PROTOCOLS, {
    features: BUILTIN_FEATURES,
    ...(switches !== undefined ? { switches } : {}),
  });
}

let builtin: ProtocolRegistry | undefined;

/**
 * The registry an entry point uses when its caller passes none: the built-in protocols with every
 * feature on, always: a host that switches protocols off passes its own registry to each call.
 * Created on first use and kept. Call it inside a function, never at module scope: the
 * modules import core files that import this one.
 */
export function defaultRegistry(): ProtocolRegistry {
  builtin ??= createBuiltinRegistry();
  return builtin;
}

/** One saved request selected for a run, of any built-in protocol a run can send. */
export type SelectedRequest = SoapSelected | RestSelected | GrpcSelected | WsSelected | McpSelected;

/** A SOAP interface's definition as a host already holds it in memory: imported and compiled. */
export type HeldSoapDefinition = Pick<WsdlImportResult, 'definition' | 'bundle' | 'schemaSet' | 'wsa'>;

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
      /** A GraphQL request's response, checked (#77). */
      readonly graphql?: GraphqlCheckResult;
    }
  | {
      readonly kind: 'grpc';
      /** The call whole: every request message as sent, every response message decoded. */
      readonly grpc: GrpcCallResult;
      /** What was sent: after the script, with the credentials resolved. */
      readonly input: GrpcResolvedInput;
      /** The request message text as sent, after the script. */
      readonly messageText: string;
    }
  | {
      readonly kind: 'websocket';
      /** The session whole: its handshake, every frame both ways, and how it closed. */
      readonly ws: WsExchange;
    }
  | {
      readonly kind: 'mcp';
      /** The session whole: every message both ways, the transport's record, and the operation's answer. */
      readonly mcp: McpExchange;
    };

/** A message an open exchange reports, whatever its protocol. */
export type LiveEvent = RestLiveEvent | GrpcLiveEvent | WsLiveEvent | McpLiveEvent;

/** The request snapshot of any built-in protocol that has scripts (spec §3.1). */
export type RequestSnapshot = RestRequestSnapshot | SoapRequestSnapshot | GrpcRequestSnapshot | McpRequestSnapshot;

/** The response snapshot of any built-in protocol that has scripts (spec §3.1). */
export type ResponseSnapshot = RestResponseSnapshot | SoapResponseSnapshot | GrpcResponseSnapshot | McpResponseSnapshot;

/**
 * A saved request of any built-in protocol, which is what a lookup by request id can return: the id
 * space is one (ULIDs), so `kind` is how a caller finds out what it has.
 */
export type AnyRequestDef = SoapRequestDef | RestRequestDef | GrpcRequestDef | WsRequestDef | McpRequestDef;
