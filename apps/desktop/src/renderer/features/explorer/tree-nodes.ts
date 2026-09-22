import type {
  GrpcApiWire,
  GrpcMethodKindWire,
  GrpcRequestWire,
  InterfaceSummary,
  OperationSummaryWire,
  RestApiWire,
  RestFolderWire,
  RestRequestWire,
  WsApiWire,
  WsRequestWire,
} from '../../../shared/wire-types.js';
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
  | 'request'
  | 'api'
  | 'folder'
  | 'rest-request'
  | 'grpc-api'
  | 'grpc-request'
  | 'ws-api'
  | 'ws-request';

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
  /**
   * Set on `request`, `rest-request`, `grpc-request` and `ws-request` nodes: the request's id.
   * One field for every protocol — `kind` is what says which one it is, and every gate that
   * cares already reads `kind`.
   */
  readonly requestId?: string;
  /** Set on `api`/`grpc-api`/`ws-api` nodes, and on the `folder` and request nodes beneath one. */
  readonly apiId?: string;
  /** Set on `folder` nodes (the folder itself) and on nodes sitting inside one (their parent). */
  readonly folderId?: string;
  /** Set on `rest-request` nodes: the HTTP method its badge shows. */
  readonly method?: string;
  /** Set on `grpc-request` nodes: the streaming shape its badge shows. */
  readonly methodKind?: GrpcMethodKindWire;
  /**
   * Set on `folder` nodes that sit inside a gRPC API. A folder row is one kind for every protocol
   * (it renames, moves and deletes the same way), but "New request" inside it has to know which
   * kind of request to make.
   */
  readonly grpc?: boolean;
  /** Set on `folder` nodes that sit inside a WebSocket API, for the same reason as {@link grpc}. */
  readonly ws?: boolean;
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
   * Set on a request node whose operation an Update Definition no longer found in the definition
   * — a WSDL operation, an OpenAPI method and path, a gRPC method or an AsyncAPI channel. The
   * request is still there (nothing is ever deleted); the row is badged so the user can see
   * which ones no longer correspond to anything the service offers.
   */
  readonly orphaned?: boolean;
  /** Set on `api` nodes whose API records the definition it was imported from (Update Definition). */
  readonly hasDefinition?: boolean;
  /**
   * Set on `project` and `request` nodes an unresolved sync conflict touches (Task 11):
   * {@link conflictTargets}'s `projectIds`/`requestIds`, joined into the tree so
   * `explorer-view.tsx` badges the row without recomputing the match itself.
   */
  readonly conflicted?: boolean;
}

/** {@link buildExplorerTree}'s conflict marks — the ids `conflictTargets` (Task 11) produced. */
export interface ExplorerConflictTargets {
  readonly projectIds: ReadonlySet<string>;
  readonly requestIds: ReadonlySet<string>;
}

/** No conflicts — the default so every existing call site (and test) needs no change. */
const NO_CONFLICTS: ExplorerConflictTargets = { projectIds: new Set(), requestIds: new Set() };

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

function operationsNode(
  interfaceId: string,
  summary: InterfaceSummary,
  requests: readonly RequestDraft[],
  conflicted: ExplorerConflictTargets,
): ExplorerNode {
  const bindings = [...new Set(summary.operations.map((op) => op.binding))];

  if (bindings.length <= 1) {
    const children = sortedOperations(summary.operations).map((op) =>
      operationNode(interfaceId, op, requests, conflicted),
    );
    return { id: `operations:${interfaceId}`, kind: 'operations', label: 'Operations', children };
  }

  const children: ExplorerNode[] = bindings.map((binding) => {
    const bindingLocal = summary.operations.find((op) => op.binding === binding)?.bindingLocal ?? binding;
    const opsForBinding = sortedOperations(summary.operations.filter((op) => op.binding === binding));
    return {
      id: `binding:${interfaceId}:${binding}`,
      kind: 'binding' as const,
      label: bindingLocal,
      children: opsForBinding.map((op) => operationNode(interfaceId, op, requests, conflicted)),
    };
  });

  return { id: `operations:${interfaceId}`, kind: 'operations', label: 'Operations', children };
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
    children: [endpointsNode(summary.id, summary), operationsNode(summary.id, summary, requests, conflicted)],
  };
}

/**
 * The folders and requests directly inside one container, interleaved by `order` so the two kinds
 * sort together — a folder the user dragged below a request stays below it.
 */
function restChildren(
  api: RestApiWire,
  parentId: string | undefined,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): ExplorerNode[] {
  const folderNodes = folders
    .filter((folder) => folder.apiId === api.id && folder.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((folder) => folderNode(api, folder, folders, requests));

  const requestNodes = requests
    .filter((request) => request.apiId === api.id && request.folderId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((request) => restRequestNode(api, request));

  return [...folderNodes, ...requestNodes];
}

function folderNode(
  api: RestApiWire,
  folder: RestFolderWire,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): ExplorerNode {
  return {
    id: `folder:${folder.id}`,
    kind: 'folder',
    label: folder.name,
    apiId: api.id,
    folderId: folder.id,
    children: restChildren(api, folder.id, folders, requests),
  };
}

function restRequestNode(api: RestApiWire, request: RestRequestWire): ExplorerNode {
  return {
    id: `rest:${request.id}`,
    kind: 'rest-request',
    label: request.name,
    requestId: request.id,
    apiId: api.id,
    method: request.method,
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/**
 * One API row and everything under it. An API is always internal (it has children, even when the
 * list is empty), so it folds like an interface rather than opening on a single click.
 */
function apiNode(
  api: RestApiWire,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): ExplorerNode {
  return {
    id: `api:${api.id}`,
    kind: 'api',
    label: api.name,
    apiId: api.id,
    // `cache`, not just a source: an update compares against the cached document, so an API
    // without one cannot be updated and must not offer the menu item.
    ...(api.definition?.cache === true ? { hasDefinition: true } : {}),
    children: restChildren(api, undefined, folders, requests),
  };
}

/** The folders and requests directly inside one gRPC container, interleaved by `order` like REST. */
function grpcChildren(
  api: GrpcApiWire,
  parentId: string | undefined,
  folders: readonly RestFolderWire[],
  requests: readonly GrpcRequestWire[],
): ExplorerNode[] {
  const folderNodes = folders
    .filter((folder) => folder.apiId === api.id && folder.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((folder) => grpcFolderNode(api, folder, folders, requests));

  const requestNodes = requests
    .filter((request) => request.apiId === api.id && request.folderId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((request) => grpcRequestNode(api, request));

  return [...folderNodes, ...requestNodes];
}

function grpcFolderNode(
  api: GrpcApiWire,
  folder: RestFolderWire,
  folders: readonly RestFolderWire[],
  requests: readonly GrpcRequestWire[],
): ExplorerNode {
  return {
    id: `folder:${folder.id}`,
    kind: 'folder',
    label: folder.name,
    apiId: api.id,
    folderId: folder.id,
    grpc: true,
    children: grpcChildren(api, folder.id, folders, requests),
  };
}

function grpcRequestNode(api: GrpcApiWire, request: GrpcRequestWire): ExplorerNode {
  return {
    id: `grpc:${request.id}`,
    kind: 'grpc-request',
    label: request.name,
    requestId: request.id,
    apiId: api.id,
    methodKind: request.methodKind,
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/** One gRPC API row and everything under it; folds like a REST API. */
function grpcApiNode(
  api: GrpcApiWire,
  folders: readonly RestFolderWire[],
  requests: readonly GrpcRequestWire[],
): ExplorerNode {
  return {
    id: `grpc-api:${api.id}`,
    kind: 'grpc-api',
    label: api.name,
    apiId: api.id,
    children: grpcChildren(api, undefined, folders, requests),
  };
}

/**
 * What one project contributes to the tree for gRPC. Folders are not here: a gRPC API's folders
 * ride in {@link ExplorerRestData.folders} beside the REST ones (they are the same shape on the
 * wire) and are told apart by their `apiId`.
 */
export interface ExplorerGrpcData {
  readonly apis: readonly GrpcApiWire[];
  readonly requests: readonly GrpcRequestWire[];
}

/** The folders and requests directly inside one WebSocket container, interleaved like REST and gRPC. */
function wsChildren(
  api: WsApiWire,
  parentId: string | undefined,
  folders: readonly RestFolderWire[],
  requests: readonly WsRequestWire[],
): ExplorerNode[] {
  const folderNodes = folders
    .filter((folder) => folder.apiId === api.id && folder.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((folder) => wsFolderNode(api, folder, folders, requests));

  const requestNodes = requests
    .filter((request) => request.apiId === api.id && request.folderId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((request) => wsRequestNode(api, request));

  return [...folderNodes, ...requestNodes];
}

function wsFolderNode(
  api: WsApiWire,
  folder: RestFolderWire,
  folders: readonly RestFolderWire[],
  requests: readonly WsRequestWire[],
): ExplorerNode {
  return {
    id: `folder:${folder.id}`,
    kind: 'folder',
    label: folder.name,
    apiId: api.id,
    folderId: folder.id,
    ws: true,
    children: wsChildren(api, folder.id, folders, requests),
  };
}

function wsRequestNode(api: WsApiWire, request: WsRequestWire): ExplorerNode {
  return {
    id: `ws:${request.id}`,
    kind: 'ws-request',
    label: request.name,
    requestId: request.id,
    apiId: api.id,
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
  };
}

/** One WebSocket API row and everything under it; folds like a REST or gRPC API. */
function wsApiNode(
  api: WsApiWire,
  folders: readonly RestFolderWire[],
  requests: readonly WsRequestWire[],
): ExplorerNode {
  return {
    id: `ws-api:${api.id}`,
    kind: 'ws-api',
    label: api.name,
    apiId: api.id,
    children: wsChildren(api, undefined, folders, requests),
  };
}

/**
 * What one project contributes to the tree for WebSocket. Folders are not here, for the same
 * reason as {@link ExplorerGrpcData}: a WebSocket API's folders ride in
 * {@link ExplorerRestData.folders} beside the REST ones.
 */
export interface ExplorerWsData {
  readonly apis: readonly WsApiWire[];
  readonly requests: readonly WsRequestWire[];
}

/** What one project contributes to the tree besides its interfaces. */
export interface ExplorerRestData {
  readonly apis: readonly RestApiWire[];
  readonly folders: readonly RestFolderWire[];
  readonly requests: readonly RestRequestWire[];
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
 * An interface and an API share one `order` space, so a project's children interleave: the two
 * lists are merged on `order` rather than one being appended after the other.
 *
 * @param projects every project in the open workspace, ready or not.
 * @param order each project's interface ids, in project order (`useProjectStore.order`).
 * @param interfaces the interface mirror, by id.
 * @param requests every open project's SOAP requests.
 * @param rest each project's APIs, folders and REST requests, by project id. Omitted for a caller
 * that has no REST data yet, which then gets exactly the tree it got before APIs existed.
 * @param conflicted ids of the projects/requests an unresolved sync conflict touches; defaults to
 *   none, so every caller unaware of sync gets an unmarked tree.
 * @param grpc each project's gRPC APIs and requests, by project id. Omitted for a caller with no
 *   gRPC data, which then gets the tree it got before gRPC existed.
 * @param ws each project's WebSocket APIs and requests, by project id. Omitted for a caller with
 *   no WebSocket data, which then gets the tree it got before the WebSocket kind existed.
 */
export function buildExplorerTree(
  projects: readonly ExplorerProject[],
  order: readonly ProjectOrder[],
  interfaces: Readonly<Record<string, InterfaceSummary>>,
  requests: readonly RequestDraft[],
  rest: Readonly<Record<string, ExplorerRestData>> = {},
  conflicted: ExplorerConflictTargets = NO_CONFLICTS,
  grpc: Readonly<Record<string, ExplorerGrpcData>> = {},
  ws: Readonly<Record<string, ExplorerWsData>> = {},
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
      : orderedChildren(
          (order.find((group) => group.projectId === project.id)?.interfaceIds ?? [])
            .map((id) => interfaces[id])
            .filter((summary): summary is InterfaceSummary => summary !== undefined),
          rest[project.id],
          requests,
          conflicted,
          grpc[project.id],
          ws[project.id],
        );

    return {
      id: `proj:${project.id}`,
      kind: 'project' as const,
      label: project.name,
      projectId: project.id,
      dir: project.dir,
      ...(project.source === 'linked' ? { linked: true } : {}),
      ...(project.status === 'loading' ? { loading: true } : {}),
      ...(conflicted.projectIds.has(project.id) ? { conflicted: true } : {}),
      children,
    };
  });
}

/**
 * A project's interfaces and APIs as one list, in `order`.
 *
 * An interface summary carries no `order` on the wire — its position is the project's own
 * `interfaceIds` order — so interfaces keep that relative order and an API is placed among them by
 * its `order` index, which is what `move-node` and `add-api` maintain on disk.
 */
function orderedChildren(
  interfaces: readonly InterfaceSummary[],
  rest: ExplorerRestData | undefined,
  requests: readonly RequestDraft[],
  conflicted: ExplorerConflictTargets,
  grpc: ExplorerGrpcData | undefined,
  ws: ExplorerWsData | undefined,
): ExplorerNode[] {
  const nodes = interfaces.map((summary, index) => ({
    order: index,
    node: interfaceNode(summary, requests, conflicted),
  }));
  const apis = [...(rest?.apis ?? [])].map((api) => ({
    order: api.order,
    node: apiNode(api, rest?.folders ?? [], rest?.requests ?? []),
  }));
  const grpcApis = [...(grpc?.apis ?? [])].map((api) => ({
    order: api.order,
    node: grpcApiNode(api, rest?.folders ?? [], grpc?.requests ?? []),
  }));
  const wsApis = [...(ws?.apis ?? [])].map((api) => ({
    order: api.order,
    node: wsApiNode(api, rest?.folders ?? [], ws?.requests ?? []),
  }));
  // A stable sort keeps an interface and an API that claim the same index in a fixed order
  // (interfaces first, then REST, then gRPC, then WebSocket), rather than letting the tree
  // reshuffle between snapshots.
  return [...nodes, ...apis, ...grpcApis, ...wsApis].sort((a, b) => a.order - b.order).map((entry) => entry.node);
}

/**
 * The entity id a `move-node` mutation addresses for one row, or `undefined` for a row that cannot
 * be moved — an interface, an operation, a project, or a SOAP request, none of which the
 * container ordering applies to.
 */
export function restEntityId(node: ExplorerNode | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (node.kind === 'api' || node.kind === 'grpc-api' || node.kind === 'ws-api') {
    return node.apiId;
  }
  if (node.kind === 'folder') {
    return node.folderId;
  }
  if (node.kind === 'rest-request' || node.kind === 'grpc-request' || node.kind === 'ws-request') {
    return node.requestId;
  }
  return undefined;
}

/**
 * The project one row belongs to, given the store's `projectOf` index. Used to gate a drop: a
 * request belongs to the API it was made in, and dragging it into another project would mean moving
 * it between two folders on disk, which `move-node` deliberately does not do.
 */
export function nodeProjectId(
  node: ExplorerNode | undefined,
  projectOf: Readonly<Record<string, string>>,
): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (node.projectId !== undefined) {
    return node.projectId;
  }
  const entity = node.apiId ?? node.folderId ?? node.requestId ?? node.interfaceId;
  return entity === undefined ? undefined : projectOf[entity];
}
