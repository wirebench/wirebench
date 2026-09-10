/**
 * Pure conversions between the engine's `Project` model — the authoritative shape the main
 * process owns and saves to disk — and the JSON-serialisable `ProjectWire` the renderer
 * mirrors. No `electron`, no `fs`: unit-tested directly against real engine models.
 */

import type { Endpoint, Environment, Interface, OperationDef, Project, RequestDef } from '@wirebench/engine';
import type {
  EndpointWire,
  EnvironmentWire,
  HydrationStatus,
  InterfaceSummary,
  InterfaceWire,
  OperationSummaryWire,
  ProjectProblemWire,
  ProjectWire,
  RequestWire,
} from '../shared/wire-types.js';

/** What the main process knows about one interface beyond the saved model. */
export interface InterfaceRuntime {
  readonly hydration: HydrationStatus;
  /** The summary produced from the engine `ImportResult`, once the definition is loaded. */
  readonly summary?: InterfaceSummary;
}

/** Everything {@link toProjectWire} needs beyond the model itself. */
export interface ProjectWireContext {
  readonly dir: string;
  readonly dirty: boolean;
  readonly lastSavedAt?: string;
  readonly problems: readonly ProjectProblemWire[];
  /** Per-interface runtime state, keyed by interface id. */
  readonly runtime: ReadonlyMap<string, InterfaceRuntime>;
}

/** The local part of a Clark-notation QName (`{ns}local`); the input itself when it has none. */
export function clarkLocalName(clark: string): string {
  const match = /^\{[^}]*\}(.*)$/.exec(clark);
  return match?.[1] ?? clark;
}

function toEndpointWire(endpoint: Endpoint): EndpointWire {
  return { id: endpoint.id, name: endpoint.name, url: endpoint.url };
}

/**
 * Operation summaries derived from the saved model alone, so the explorer can render an
 * interface's tree before its definition has finished hydrating. Anything only the WSDL
 * knows (ports, style, SOAPAction) is filled in once the real summary arrives.
 */
function operationsFromModel(iface: Interface): OperationSummaryWire[] {
  return iface.operations.map((operation) => ({
    name: operation.name,
    binding: operation.bindingName,
    bindingLocal: clarkLocalName(operation.bindingName),
    soapVersion: operation.requests[0]?.soapVersion ?? '1.1',
    style: 'document' as const,
    ports: [],
  }));
}

/**
 * Merges the hydrated summary's operations with the ones the model declares, so a request
 * saved against an operation the current WSDL no longer exposes still shows up in the tree.
 */
function mergeOperations(iface: Interface, summary: InterfaceSummary | undefined): OperationSummaryWire[] {
  const fromModel = operationsFromModel(iface);
  if (summary === undefined) {
    return fromModel;
  }
  const key = (op: OperationSummaryWire): string => `${op.binding} ${op.name}`;
  const known = new Set(summary.operations.map(key));
  return [...summary.operations, ...fromModel.filter((op) => !known.has(key(op)))];
}

/** Converts one saved interface (plus whatever the engine knows about it) to its wire shape. */
export function toInterfaceWire(iface: Interface, runtime: InterfaceRuntime | undefined): InterfaceWire {
  const summary = runtime?.summary;
  return {
    id: iface.id,
    name: iface.name,
    slug: iface.slug,
    definitionUrl: iface.definitionUrl,
    cacheDefinition: iface.cacheDefinition,
    targetNamespace: iface.targetNamespace ?? summary?.targetNamespace ?? '',
    soapVersions: summary?.soapVersions ?? [],
    services: summary?.services ?? [],
    operations: mergeOperations(iface, summary),
    problems: summary?.problems ?? [],
    documentCount: summary?.documentCount ?? 0,
    endpoints: iface.endpoints.map(toEndpointWire),
    ...(iface.defaultEndpointId !== undefined ? { defaultEndpointId: iface.defaultEndpointId } : {}),
    hydration: runtime?.hydration ?? 'pending',
  };
}

/** Converts one saved request to its wire shape, flattened out of its owning operation. */
export function toRequestWire(iface: Interface, operation: OperationDef, request: RequestDef): RequestWire {
  return {
    id: request.id,
    interfaceId: iface.id,
    bindingName: operation.bindingName,
    operationName: operation.name,
    name: request.name,
    envelopeXml: request.envelopeXml,
    soapVersion: request.soapVersion,
    ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
    ...(request.endpointId !== undefined ? { endpointId: request.endpointId } : {}),
    ...(request.endpointUrl !== undefined ? { endpointUrl: request.endpointUrl } : {}),
    headers: request.headers.map((header) => ({ name: header.name, value: header.value })),
    order: request.order,
  };
}

/** Every request of a project, in interface then operation then request order. */
export function toRequestWires(project: Project): RequestWire[] {
  return project.interfaces.flatMap((iface) =>
    iface.operations.flatMap((operation) =>
      operation.requests.map((request) => toRequestWire(iface, operation, request)),
    ),
  );
}

function toEnvironmentWire(environment: Environment): EnvironmentWire {
  return {
    id: environment.id,
    name: environment.name,
    slug: environment.slug,
    order: environment.order,
    endpoints: { ...environment.endpoints },
    properties: { ...environment.properties },
  };
}

/** Converts the whole open project into the snapshot the renderer mirrors. */
export function toProjectWire(project: Project, context: ProjectWireContext): ProjectWire {
  return {
    id: project.id,
    name: project.name,
    dir: context.dir,
    dirty: context.dirty,
    ...(context.lastSavedAt !== undefined ? { lastSavedAt: context.lastSavedAt } : {}),
    interfaces: project.interfaces.map((iface) => toInterfaceWire(iface, context.runtime.get(iface.id))),
    requests: toRequestWires(project),
    properties: { ...project.properties },
    environments: project.environments.map(toEnvironmentWire),
    problems: [...context.problems],
  };
}

/** Where a request lives inside the model: its owning interface and operation. */
export interface RequestLocation {
  readonly iface: Interface;
  readonly operation: OperationDef;
  readonly request: RequestDef;
}

/** Locates a request (and its owning interface/operation) by id, or `undefined` when unknown. */
export function findRequest(project: Project, requestId: string): RequestLocation | undefined {
  for (const iface of project.interfaces) {
    for (const operation of iface.operations) {
      const request = operation.requests.find((candidate) => candidate.id === requestId);
      if (request !== undefined) {
        return { iface, operation, request };
      }
    }
  }
  return undefined;
}
