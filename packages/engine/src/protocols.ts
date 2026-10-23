/**
 * The composition file (spec §4.3): the one file that imports every built-in protocol module. It
 * installs the built-in registry every entry point falls back to, and re-exports the unions a host
 * that narrows on `kind` uses, which the modules fill (`protocol/unions.ts`).
 */
import { GRAPHQL_FEATURE, graphqlSupport } from '#protocol-graphql/graphql/support';
import { grpcProtocol } from '#protocol-grpc/grpc/module';
import { mcpProtocol } from '#protocol-mcp/mcp/module';
import type { ExtensionContributions } from '#core/extension/registry';
import type { FeatureDescriptor } from '#core/protocol/features';
import type { ProtocolModule } from '#core/protocol/module';
import { installDefaultRegistry } from '#core/protocol/default-registry';
import { createProtocolRegistry } from '#core/protocol/registry';
import type { ProtocolRegistry } from '#core/protocol/registry';
import { installRestGraphql } from '#protocol-rest/rest/graphql-slot';
import { restProtocol } from '#protocol-rest/rest/module';
import { soapProtocol } from '#protocol-soap/soap/module';
import { wsProtocol } from '#protocol-ws/ws/module';
import { builtinExtensions } from './extensions.js';

// The declarations of @wirebench/engine reach every file that fills the unions (package split spec
// §3.4) only through these re-exports: a value import of a module leaves no trace in a `.d.ts`, and a
// host that compiles against `dist` would otherwise see a union missing the members of every file
// its own imports do not happen to reach.
export type { GrpcLiveEvent } from '#protocol-grpc/grpc/events';
export type { GrpcRequestDef } from '#protocol-grpc/grpc/model';
export type { GrpcSelected } from '#protocol-grpc/grpc/run';
export type { GrpcRequestSnapshot, GrpcResponseSnapshot } from '#protocol-grpc/grpc/scripting';
export type { McpLiveEvent } from '#protocol-mcp/mcp/events';
export type { McpRequestDef } from '#protocol-mcp/mcp/model';
export type { McpSelected } from '#protocol-mcp/mcp/run';
export type { McpRequestSnapshot, McpResponseSnapshot } from '#protocol-mcp/mcp/scripting';
export type { RestLiveEvent } from '#protocol-rest/rest/events';
export type { RestRequestDef } from '#protocol-rest/rest/model';
export type { RestSelected } from '#protocol-rest/rest/run';
export type { RestRequestSnapshot, RestResponseSnapshot } from '#protocol-rest/rest/scripting';
export type { SoapRequestDef } from '#protocol-soap/soap/model';
export type { SoapSelected } from '#protocol-soap/soap/run';
export type { SoapRequestSnapshot, SoapResponseSnapshot } from '#protocol-soap/soap/scripting';
export type { WsLiveEvent } from '#protocol-ws/ws/events';
export type { WsRequestDef } from '#protocol-ws/ws/model';
export type { WsSelected } from '#protocol-ws/ws/run';

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
 * them: GraphQL beside the protocols, automation, then what needs a server. `scripts` is
 * {@link SCRIPTS_FEATURE}.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export const BUILTIN_FEATURES: readonly FeatureDescriptor[] = [
  // A REST body kind, not a protocol module, so the registry is told of it (phase 6 spec §3.3).
  GRAPHQL_FEATURE,
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
 * A registry of the built-in protocols and {@link BUILTIN_FEATURES}, with `switches` applied, and the
 * built-in importers, reporters and code generators with a host's `extensions` after them.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function createBuiltinRegistry(
  switches?: Readonly<Record<string, boolean>>,
  extensions?: ExtensionContributions,
): ProtocolRegistry {
  return createProtocolRegistry(BUILTIN_PROTOCOLS, {
    features: BUILTIN_FEATURES,
    extensions: builtinExtensions(extensions),
    ...(switches !== undefined ? { switches } : {}),
  });
}

// The registry an entry point uses when its caller passes none (spec §3.3): the built-in protocols
// with every feature on. Core holds the slot; loading this file fills it.
installDefaultRegistry(createBuiltinRegistry);
// GraphQL is a REST body kind whose meaning lives in its own package (phase 6 spec §3.2): REST's slot
// is filled here, the one place that composes both.
installRestGraphql(graphqlSupport);
export { defaultRegistry } from '#core/protocol/default-registry';

export type {
  AnyRequestDef,
  LiveEvent,
  RequestSnapshot,
  ResponseSnapshot,
  SelectedRequest,
  SentExchange,
} from '#core/protocol/unions';
export type { HeldSoapDefinition } from '#protocol-soap/soap/run';
