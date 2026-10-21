import type { InterfaceSummary, OperationSummaryWire } from '../../../shared/kinds/soap/wire.js';
import type { ExplorerConflictTargets, ExplorerNode } from '../../features/explorer/tree-nodes.js';
import type { RequestDraft } from '../../state/project.js';
import type { KindExplorerTree } from '../explorer-tree.js';

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
  conflicted: ExplorerConflictTargets,
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
      ...(conflicted.requestIds.has(r.id) ? { conflicted: true } : {}),
    }));
}

function operationNode(
  interfaceId: string,
  operation: OperationSummaryWire,
  requests: readonly RequestDraft[],
  conflicted: ExplorerConflictTargets,
): ExplorerNode {
  return {
    id: `op:${interfaceId}:${operation.binding}:${operation.name}`,
    kind: 'operation',
    label: operation.name,
    interfaceId,
    bindingName: operation.binding,
    operationName: operation.name,
    ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
    children: requestNodes(interfaceId, operation, requests, conflicted),
  };
}

function sortedOperations(operations: readonly OperationSummaryWire[]): OperationSummaryWire[] {
  return [...operations].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * An interface's operations, straight under it (#732 X15): no "Operations" folder. Bindings that differ
 * only by SOAP version (a 1.1 and a 1.2 of one port type) list each operation once, with its versions
 * after the name and every binding's requests under it; those already say their version (#726). Other
 * bindings, such as two of one version, keep a row each.
 */
function operationChildren(
  interfaceId: string,
  summary: InterfaceSummary,
  requests: readonly RequestDraft[],
  conflicted: ExplorerConflictTargets,
): ExplorerNode[] {
  const bindings = [...new Set(summary.operations.map((op) => op.binding))];
  if (bindings.length <= 1) {
    return sortedOperations(summary.operations).map((op) => operationNode(interfaceId, op, requests, conflicted));
  }

  const versionOf = new Map(summary.operations.map((op) => [op.binding, op.soapVersion]));
  const versions = bindings.map((binding) => versionOf.get(binding));
  const byVersion = !versions.includes('none') && new Set(versions).size === bindings.length;
  if (byVersion) {
    const names = [...new Set(summary.operations.map((op) => op.name))].sort((a, b) => a.localeCompare(b));
    return names.map((name) => {
      // The 1.1 binding first: it is the one New Request uses, as the lower version is the commoner one.
      const variants = summary.operations
        .filter((op) => op.name === name)
        .sort((a, b) => a.soapVersion.localeCompare(b.soapVersion));
      const primary = variants[0] as OperationSummaryWire;
      const node = operationNode(interfaceId, primary, requests, conflicted);
      if (variants.length === 1) {
        return { ...node, suffix: `SOAP ${primary.soapVersion}` };
      }
      return {
        ...node,
        suffix: `SOAP ${variants.map((op) => op.soapVersion).join(' · ')}`,
        children: variants.flatMap((op) => requestNodes(interfaceId, op, requests, conflicted)),
      };
    });
  }

  return bindings.map((binding) => {
    const bindingLocal = summary.operations.find((op) => op.binding === binding)?.bindingLocal ?? binding;
    const opsForBinding = sortedOperations(summary.operations.filter((op) => op.binding === binding));
    return {
      id: `binding:${interfaceId}:${binding}`,
      kind: 'binding' as const,
      label: bindingLocal,
      interfaceId,
      bindingName: binding,
      children: opsForBinding.map((op) => operationNode(interfaceId, op, requests, conflicted)),
    };
  });
}

function interfaceNode(
  summary: InterfaceSummary,
  requests: readonly RequestDraft[],
  conflicted: ExplorerConflictTargets,
): ExplorerNode {
  return {
    id: `iface:${summary.id}`,
    kind: 'interface',
    label: summary.name,
    interfaceId: summary.id,
    ...(summary.problems.length > 0 ? { problemCount: summary.problems.length } : {}),
    children: [endpointsNode(summary.id, summary), ...operationChildren(summary.id, summary, requests, conflicted)],
  };
}

/**
 * SOAP's containers: each interface, placed by its index in the project's `interfaceIds`. An
 * interface summary carries no `order` on the wire; its position is the project's own order.
 */
export const soapExplorerTree: KindExplorerTree = {
  scriptContainers: ['interface'],
  kind: 'soap',
  containers: ({ interfaces, requests, conflicted }) =>
    interfaces.map((summary, index) => ({ order: index, node: interfaceNode(summary, requests, conflicted) })),
};
