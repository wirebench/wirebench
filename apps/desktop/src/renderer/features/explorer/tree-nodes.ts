import type { InterfaceSummary, OperationSummaryWire } from '../../../shared/wire-types.js';
import type { RequestDraft } from '../../state/project.js';

/** The kinds of node the explorer tree renders; also gates which context menu/commands apply. */
export type ExplorerNodeKind =
  'interface' | 'endpoints' | 'endpoint' | 'operations' | 'binding' | 'operation' | 'request';

/** One node in the explorer tree, in the shape `react-arborist` (and the tests) consume directly. */
export interface ExplorerNode {
  readonly id: string;
  readonly kind: ExplorerNodeKind;
  readonly label: string;
  readonly children?: ExplorerNode[];
  /** Set on `interface` nodes with at least one import/schema problem. */
  readonly problemCount?: number;
  /** Set on `endpoint` nodes: the port's address, for "Copy address". */
  readonly address?: string;
  /** Set on `operation`/`binding` nodes: identifies which interface/operation this maps to. */
  readonly interfaceId?: string;
  readonly bindingName?: string;
  readonly operationName?: string;
  readonly soapAction?: string;
  /** Set on `request` nodes: the request draft id. */
  readonly requestId?: string;
  /**
   * Set on `request` nodes whose operation an Update Definition dropped from the WSDL. The
   * request is still there (nothing is ever deleted); the row is badged so the user can see
   * which ones no longer correspond to anything the service offers.
   */
  readonly orphaned?: boolean;
}

function endpointsNode(interfaceId: string, summary: InterfaceSummary): ExplorerNode {
  const children: ExplorerNode[] = summary.services.flatMap((service) =>
    service.ports.map((port) => ({
      id: `endpoint:${interfaceId}:${service.name}:${port.name}`,
      kind: 'endpoint' as const,
      label: port.address !== undefined ? `${port.name} — ${port.address}` : port.name,
      ...(port.address !== undefined ? { address: port.address } : {}),
    })),
  );
  return { id: `endpoints:${interfaceId}`, kind: 'endpoints', label: 'Endpoints', children };
}

function requestNodes(
  interfaceId: string,
  operation: OperationSummaryWire,
  requests: readonly RequestDraft[],
): ExplorerNode[] {
  return requests
    .filter(
      (r) => r.interfaceId === interfaceId && r.bindingName === operation.binding && r.operationName === operation.name,
    )
    .map((r) => ({
      id: `req:${r.id}`,
      kind: 'request' as const,
      label: r.name,
      requestId: r.id,
      ...(r.orphaned === true ? { orphaned: true } : {}),
    }));
}

function operationNode(
  interfaceId: string,
  operation: OperationSummaryWire,
  requests: readonly RequestDraft[],
): ExplorerNode {
  return {
    id: `op:${interfaceId}:${operation.binding}:${operation.name}`,
    kind: 'operation',
    label: operation.name,
    interfaceId,
    bindingName: operation.binding,
    operationName: operation.name,
    ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
    children: requestNodes(interfaceId, operation, requests),
  };
}

function sortedOperations(operations: readonly OperationSummaryWire[]): OperationSummaryWire[] {
  return [...operations].sort((a, b) => a.name.localeCompare(b.name));
}

function operationsNode(
  interfaceId: string,
  summary: InterfaceSummary,
  requests: readonly RequestDraft[],
): ExplorerNode {
  const bindings = [...new Set(summary.operations.map((op) => op.binding))];

  if (bindings.length <= 1) {
    const children = sortedOperations(summary.operations).map((op) => operationNode(interfaceId, op, requests));
    return { id: `operations:${interfaceId}`, kind: 'operations', label: 'Operations', children };
  }

  const children: ExplorerNode[] = bindings.map((binding) => {
    const bindingLocal = summary.operations.find((op) => op.binding === binding)?.bindingLocal ?? binding;
    const opsForBinding = sortedOperations(summary.operations.filter((op) => op.binding === binding));
    return {
      id: `binding:${interfaceId}:${binding}`,
      kind: 'binding' as const,
      label: bindingLocal,
      children: opsForBinding.map((op) => operationNode(interfaceId, op, requests)),
    };
  });

  return { id: `operations:${interfaceId}`, kind: 'operations', label: 'Operations', children };
}

/**
 * Pure mapping from the project store's `interfaces`/`requests` to the tree `react-arborist`
 * renders: Interface -> Endpoints / Operations (grouped by binding when there is more than
 * one) -> Requests. No React, no store access — trivially unit-testable.
 */
export function buildExplorerTree(
  interfaces: readonly InterfaceSummary[],
  requests: readonly RequestDraft[],
): ExplorerNode[] {
  return interfaces.map((summary) => ({
    id: `iface:${summary.id}`,
    kind: 'interface' as const,
    label: summary.name,
    interfaceId: summary.id,
    ...(summary.problems.length > 0 ? { problemCount: summary.problems.length } : {}),
    children: [endpointsNode(summary.id, summary), operationsNode(summary.id, summary, requests)],
  }));
}
