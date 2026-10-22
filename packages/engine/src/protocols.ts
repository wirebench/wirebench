/**
 * The composition file (spec §4.3): the one file that imports every built-in protocol module. It
 * installs the built-in registry every entry point falls back to, and re-exports the unions a host
 * that narrows on `kind` uses, which the modules fill (`protocol/unions.ts`).
 */
import { grpcProtocol } from './grpc/module.js';
import { mcpProtocol } from './mcp/module.js';
import type { FeatureDescriptor } from './protocol/features.js';
import type { ProtocolModule } from './protocol/module.js';
import { installDefaultRegistry } from './protocol/default-registry.js';
import { createProtocolRegistry } from './protocol/registry.js';
import type { ProtocolRegistry } from './protocol/registry.js';
import { restProtocol } from './rest/module.js';
import { soapProtocol } from './soap/module.js';
import { wsProtocol } from './ws/module.js';

// The declarations of @wirebench/engine reach every file that fills the unions (package split spec
// §3.4) only through these re-exports: a value import of a module leaves no trace in a `.d.ts`, and a
// host that compiles against `dist` would otherwise see a union missing the members of every file
// its own imports do not happen to reach.
export type { GrpcLiveEvent } from './grpc/events.js';
export type { GrpcRequestDef } from './grpc/model.js';
export type { GrpcSelected } from './grpc/run.js';
export type { GrpcRequestSnapshot, GrpcResponseSnapshot } from './grpc/scripting.js';
export type { McpLiveEvent } from './mcp/events.js';
export type { McpRequestDef } from './mcp/model.js';
export type { McpSelected } from './mcp/run.js';
export type { McpRequestSnapshot, McpResponseSnapshot } from './mcp/scripting.js';
export type { RestLiveEvent } from './rest/events.js';
export type { RestRequestDef } from './rest/model.js';
export type { RestSelected } from './rest/run.js';
export type { RestRequestSnapshot, RestResponseSnapshot } from './rest/scripting.js';
export type { SoapRequestDef } from './soap/model.js';
export type { SoapSelected } from './soap/run.js';
export type { SoapRequestSnapshot, SoapResponseSnapshot } from './soap/scripting.js';
export type { WsLiveEvent } from './ws/events.js';
export type { WsRequestDef } from './ws/model.js';
export type { WsSelected } from './ws/run.js';

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

// The registry an entry point uses when its caller passes none (spec §3.3): the built-in protocols
// with every feature on. Core holds the slot; loading this file fills it.
installDefaultRegistry(createBuiltinRegistry);
export { defaultRegistry } from './protocol/default-registry.js';

export type {
  AnyRequestDef,
  LiveEvent,
  RequestSnapshot,
  ResponseSnapshot,
  SelectedRequest,
  SentExchange,
} from './protocol/unions.js';
export type { HeldSoapDefinition } from './soap/run.js';
