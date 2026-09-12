import type { InterfaceSummary, OperationSummaryWire } from '../../../shared/wire-types.js';
import type { ProjectOrder, RequestDraft } from '../../state/project.js';

/** The kinds of node the explorer tree renders; also gates which context menu/commands apply. */
export type ExplorerNodeKind =
  | 'project'
  /** The *Locate… / Remove* row under a project whose folder the app cannot read. */
  | 'project-missing'
  | 'interface'
  | 'endpoints'
  | 'endpoint'
  | 'operations'
  | 'binding'
  | 'operation'
  | 'request';

/**
 * What the tree needs to know about one project in the open workspace. Structurally the subset
 * of `WorkspaceProjectWire` the explorer reads, so the wire type is assignable to it — the
 * *name* is taken from the renderer's project mirror where it has one, since a rename reaches
 * the mirror (`project.changed`) before it reaches the workspace snapshot.
 */
export interface ExplorerProject {
  readonly id: string;
  readonly name: string;
  readonly source: 'internal' | 'linked';
  /** The project folder, shown as the link badge's tooltip. Never sent back to main. */
  readonly dir: string;
  readonly status: 'loading' | 'ready' | 'missing' | 'error';
  readonly message?: string;
}

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
  /** Set on `project`/`project-missing` nodes: the project this root stands for. */
  readonly projectId?: string;
  /** Set on `project` nodes: whether the folder is linked from outside the workspace. */
  readonly linked?: boolean;
  /** Set on `project` nodes: the project folder, for the link badge's tooltip. */
  readonly dir?: string;
  /** Set on `project` nodes: `true` while the project is still opening. */
  readonly loading?: boolean;
  /** Set on `project-missing` nodes: why the folder could not be read, when main said. */
  readonly message?: string;
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

function interfaceNode(summary: InterfaceSummary, requests: readonly RequestDraft[]): ExplorerNode {
  return {
    id: `iface:${summary.id}`,
    kind: 'interface',
    label: summary.name,
    interfaceId: summary.id,
    ...(summary.problems.length > 0 ? { problemCount: summary.problems.length } : {}),
    children: [endpointsNode(summary.id, summary), operationsNode(summary.id, summary, requests)],
  };
}

/**
 * Pure mapping from the open workspace's projects and the project store's indexes to the tree
 * `react-arborist` renders: Project -> Interface -> Endpoints / Operations (grouped by binding
 * when there is more than one) -> Requests. No React, no store access — trivially unit-testable.
 *
 * One root per project, in `projects` order (main's, i.e. the workspace manifest's). Only the
 * project root's id is prefixed: every id below it is an entity id, which is a ULID and so is
 * already unique across the whole workspace.
 *
 * @param projects every project in the open workspace, ready or not.
 * @param order each project's interface ids, in project order (`useProjectStore.order`).
 * @param interfaces the interface mirror, by id.
 * @param requests every open project's requests.
 */
export function buildExplorerTree(
  projects: readonly ExplorerProject[],
  order: readonly ProjectOrder[],
  interfaces: Readonly<Record<string, InterfaceSummary>>,
  requests: readonly RequestDraft[],
): ExplorerNode[] {
  return projects.map((project) => {
    const broken = project.status === 'missing' || project.status === 'error';
    const children: ExplorerNode[] = broken
      ? [
          {
            id: `projmissing:${project.id}`,
            kind: 'project-missing',
            label:
              project.message ??
              (project.status === 'missing' ? 'This project folder is missing.' : 'This project could not be opened.'),
            projectId: project.id,
            ...(project.message !== undefined ? { message: project.message } : {}),
          },
        ]
      : (order.find((group) => group.projectId === project.id)?.interfaceIds ?? [])
          .map((id) => interfaces[id])
          .filter((summary): summary is InterfaceSummary => summary !== undefined)
          .map((summary) => interfaceNode(summary, requests));

    return {
      id: `proj:${project.id}`,
      kind: 'project' as const,
      label: project.name,
      projectId: project.id,
      dir: project.dir,
      ...(project.source === 'linked' ? { linked: true } : {}),
      ...(project.status === 'loading' ? { loading: true } : {}),
      children,
    };
  });
}
