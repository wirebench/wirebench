import type { GrpcApiWire, GrpcMethodKindWire, GrpcRequestWire } from '../../../shared/kinds/grpc/wire.js';
import type { RestApiWire, RestRequestWire, WebhookCollectionWire } from '../../../shared/kinds/rest/wire.js';
import type { InterfaceSummary } from '../../../shared/kinds/soap/wire.js';
import type { WsApiWire, WsRequestWire } from '../../../shared/kinds/ws/wire.js';
import type { RestFolderWire, ScriptValueWire, UnsupportedContainerWire } from '../../../shared/wire-base.js';
import type { KindId } from '../../../shared/kinds/kind-module.js';
import { EXPLORER_TREES } from '../../kinds/explorer-trees.js';
import { placeholderMessage } from '../../kinds/placeholders.js';
import type { ProjectTreeData } from '../../kinds/explorer-tree.js';
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
  | 'ws-request'
  /** A project's webhook collection (openapi-webhooks-import §3.1): its root, one per project. */
  | 'webhook-collection'
  | 'webhook-folder'
  | 'webhook-request'
  /** The open workspace's catch URLs on its server (webhook-capture §4.2); a root after the projects. */
  | 'webhooks'
  | 'catch-url'
  /** The group of a project's sequences; a container, not an entity. */
  | 'sequences'
  | 'sequence'
  /** The group of a project's mock services (#59); a container, not an entity. */
  | 'mocks'
  | 'mock'
  /** A project's session values (#63): what single sends' scripts set; a container, not an entity. */
  | 'values'
  | 'value'
  /** A container of a kind that is switched off or unknown (kind modules spec §7.2): shown, never opened or changed. */
  | 'placeholder';

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
   * Set on `folder` nodes: the kind whose API the folder sits in. A folder row is one kind for every
   * protocol (it renames, moves and deletes the same way), but "New request" inside it has to know
   * which kind of request to make.
   */
  readonly ownerKind?: KindId;
  /** Set on `project`/`project-missing` nodes: the project this root stands for. */
  readonly projectId?: string;
  /** Set on `project` nodes: whether the folder is linked from outside the workspace. */
  readonly linked?: boolean;
  /** Set on `project` nodes: the project folder, for the link badge's tooltip. */
  readonly dir?: string;
  /** Set on `project` nodes: `true` while the project is still opening. */
  readonly loading?: boolean;
  /**
   * Set on `project-missing` nodes: why the folder could not be read, when main said. Set on
   * `placeholder` nodes: why the container cannot be opened or changed.
   */
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
  /** Set on `catch-url` nodes: the catch URL's id. */
  readonly hookId?: string;
  /** Set on `webhooks` and `catch-url` nodes: whether the caller's role may change catch URLs. */
  readonly canEdit?: boolean;
  /** Set on `catch-url` nodes: `false` when the catch URL answers `404` to every sender. */
  readonly enabled?: boolean;
  /** Set on `catch-url` nodes: captures this device has not seen, and whether there are more than that. */
  readonly unseen?: number;
  readonly unseenMore?: boolean;
  /** Set on `sequence` nodes: the sequence the row stands for. */
  readonly sequenceId?: string;
  /** Set on `mock` nodes: the mock the row stands for. */
  readonly mockId?: string;
  /**
   * Set on a `webhook-request` node imported as a callback: its parent operation, rendered muted
   * after the label — the linked API's request for that operation when one is found, else the
   * operation's own contract key (`hook.operation`).
   */
  readonly suffix?: string;
  /**
   * Set on an interface, API or folder whose own scripts, or whose requests' or inner folders'
   * scripts, are switched off (#63, #334): their ids, for **Switch on scripts…**.
   */
  readonly scriptsOff?: readonly string[];
  /** Set on `placeholder` nodes: the kind of the container it stands for, as its file names it. */
  readonly placeholderKind?: string;
}

/** What the explorer shows of one mock. */
export interface ExplorerMock {
  readonly id: string;
  readonly name: string;
}

/** What the explorer shows of one sequence. */
export interface ExplorerSequence {
  readonly id: string;
  readonly name: string;
}

/** {@link buildExplorerTree}'s conflict marks — the ids `conflictTargets` (Task 11) produced. */
export interface ExplorerConflictTargets {
  readonly projectIds: ReadonlySet<string>;
  readonly requestIds: ReadonlySet<string>;
}

/** No conflicts — the default so every existing call site (and test) needs no change. */
const NO_CONFLICTS: ExplorerConflictTargets = { projectIds: new Set(), requestIds: new Set() };

/**
 * What one project contributes to the tree for gRPC. Folders are not here: a gRPC API's folders
 * ride in {@link ExplorerRestData.folders} beside the REST ones (they are the same shape on the
 * wire) and are told apart by their `apiId`.
 */
export interface ExplorerGrpcData {
  readonly apis: readonly GrpcApiWire[];
  readonly requests: readonly GrpcRequestWire[];
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
 * The folders and requests directly inside one webhook collection (or a folder in it), interleaved
 * like a REST API's: they ride in the same `folders`/`requests` lists REST does — told apart by
 * `apiId` (`webhooks:<projectId>`, never a real API id) — so this mirrors {@link restChildren}.
 */
function webhookChildren(
  collectionId: string,
  projectId: string,
  parentId: string | undefined,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): ExplorerNode[] {
  const folderNodes = folders
    .filter((folder) => folder.apiId === collectionId && folder.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((folder) => webhookFolderNode(collectionId, projectId, folder, folders, requests));

  const requestNodes = requests
    .filter((request) => request.apiId === collectionId && request.folderId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((request) => webhookRequestNode(projectId, request, folders, requests));

  return [...folderNodes, ...requestNodes];
}

function webhookFolderNode(
  collectionId: string,
  projectId: string,
  folder: RestFolderWire,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): ExplorerNode {
  return {
    id: `webhook-folder:${folder.id}`,
    kind: 'webhook-folder',
    label: folder.name,
    projectId,
    folderId: folder.id,
    ...(folder.source !== undefined ? { linked: true } : {}),
    children: webhookChildren(collectionId, projectId, folder.id, folders, requests),
  };
}

function webhookRequestNode(
  projectId: string,
  request: RestRequestWire,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): ExplorerNode {
  const suffix = webhookSuffix(request, folders, requests);
  return {
    id: `webhook-request:${request.id}`,
    kind: 'webhook-request',
    label: request.name,
    projectId,
    requestId: request.id,
    method: request.method,
    ...(request.folderId !== undefined ? { folderId: request.folderId } : {}),
    ...(request.orphaned === true ? { orphaned: true } : {}),
    ...(suffix !== undefined ? { suffix } : {}),
  };
}

/**
 * A callback request's muted suffix: the imported API's own request for `hook.operation` (its
 * contract key, e.g. `post /subscriptions`) when one is found among the project's REST requests,
 * else the operation key itself. `undefined` for a webhook (not a callback) item.
 */
function webhookSuffix(
  request: RestRequestWire,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): string | undefined {
  const hook = request.hook;
  if (hook === undefined || hook.kind !== 'callback') {
    return undefined;
  }
  const sourceApiId = webhookSourceApiId(request.folderId, folders);
  const parent =
    sourceApiId === undefined
      ? undefined
      : requests.find(
          (candidate) =>
            candidate.apiId === sourceApiId && `${candidate.method.toLowerCase()} ${candidate.url}` === hook.operation,
        );
  return parent?.name ?? hook.operation;
}

/** The nearest ancestor folder's `source.apiId`, walking up from `folderId` — undefined off a chain with none. */
function webhookSourceApiId(folderId: string | undefined, folders: readonly RestFolderWire[]): string | undefined {
  let at = folderId;
  const seen = new Set<string>();
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    const folder = folders.find((candidate) => candidate.id === at);
    if (folder === undefined) {
      return undefined;
    }
    if (folder.source !== undefined) {
      return folder.source.apiId;
    }
    at = folder.parentId;
  }
  return undefined;
}

function webhookCollectionNode(
  projectId: string,
  collection: WebhookCollectionWire,
  folders: readonly RestFolderWire[],
  requests: readonly RestRequestWire[],
): ExplorerNode {
  return {
    id: `webhook-collection:${projectId}`,
    kind: 'webhook-collection',
    label: 'Webhooks',
    projectId,
    children: webhookChildren(collection.id, projectId, undefined, folders, requests),
  };
}

/** A project's Webhooks group: one node when it has a collection, none when it does not. */
function webhookCollectionGroup(
  projectId: string,
  collection: WebhookCollectionWire | undefined,
  rest: ExplorerRestData | undefined,
): ExplorerNode[] {
  if (collection === undefined) {
    return [];
  }
  return [webhookCollectionNode(projectId, collection, rest?.folders ?? [], rest?.requests ?? [])];
}

/** The Webhooks root's input: present only when the workspace's server offers catch URLs. */
export interface ExplorerWebhooks {
  readonly canEdit: boolean;
  readonly hooks: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly unseen: { readonly count: number; readonly more: boolean };
  }[];
}

export const WEBHOOKS_ROOT_ID = 'webhooks';

/** The workspace's catch-URL inbox root — R2: relabelled from *Webhooks* now that each project has its own. */
export function webhooksNode(webhooks: ExplorerWebhooks): ExplorerNode {
  return {
    id: WEBHOOKS_ROOT_ID,
    kind: 'webhooks',
    label: 'Webhook inbox',
    canEdit: webhooks.canEdit,
    children: webhooks.hooks.map((hook) => ({
      id: `catch-url:${hook.id}`,
      kind: 'catch-url' as const,
      label: hook.name,
      hookId: hook.id,
      canEdit: webhooks.canEdit,
      enabled: hook.enabled,
      unseen: hook.unseen.count,
      unseenMore: hook.unseen.more,
    })),
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
 * @param sequences each project's sequences, in order, by project id. A project with none shows no
 *   Sequences group at all.
 * @param webhooks the Webhooks root's catch URLs; omitted when the workspace's server offers none.
 * @param webhookCollections each project's webhook collection, by project id (openapi-webhooks-import
 *   §3.1). A project with none shows no Webhooks node. Its folders and requests are read from `rest`
 *   (they ride in the same `folders`/`requests` lists, told apart by `apiId`).
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
  sequences: Readonly<Record<string, readonly ExplorerSequence[]>> = {},
  webhooks?: ExplorerWebhooks,
  webhookCollections: Readonly<Record<string, WebhookCollectionWire>> = {},
  values: Readonly<Record<string, readonly ScriptValueWire[]>> = {},
  mocks: Readonly<Record<string, readonly ExplorerMock[]>> = {},
  placeholders: Readonly<Record<string, readonly UnsupportedContainerWire[]>> = {},
): ExplorerNode[] {
  // Every request, interface, API and folder whose scripts are switched off, whichever protocol it is.
  const owners: readonly { readonly id: string; readonly scripts?: { readonly enabled: boolean } | undefined }[] = [
    ...requests,
    ...Object.values(rest).flatMap((data) => [...data.requests, ...data.apis, ...data.folders]),
    ...Object.values(grpc).flatMap((data) => [...data.requests, ...data.apis]),
    ...Object.values(interfaces),
  ];
  const scriptsOff = new Set(owners.filter((owner) => owner.scripts?.enabled === false).map((owner) => owner.id));
  const roots = projects.map((project) => {
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
          {
            interfaces: (order.find((group) => group.projectId === project.id)?.interfaceIds ?? [])
              .map((id) => interfaces[id])
              .filter((summary): summary is InterfaceSummary => summary !== undefined),
            requests,
            conflicted,
            rest: rest[project.id],
            grpc: grpc[project.id],
            ws: ws[project.id],
          },
          project.id,
          placeholders[project.id] ?? [],
        )
          .map((node) => (scriptsOff.size === 0 ? node : withScriptsOff(node, scriptsOff)))
          .concat(webhookCollectionGroup(project.id, webhookCollections[project.id], rest[project.id]))
          .concat(sequencesGroup(project.id, sequences[project.id] ?? []))
          .concat(mocksGroup(project.id, mocks[project.id] ?? []))
          .concat(valuesGroup(project.id, values[project.id] ?? []));

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
  return webhooks === undefined ? roots : [...roots, webhooksNode(webhooks)];
}

/**
 * A project's containers as one list, in `order`: each kind adds its own (`EXPLORER_TREES`), and
 * a stable sort keeps two that claim the same index in the kinds' order (interfaces first, then
 * REST, then gRPC, then WebSocket) rather than letting the tree reshuffle between snapshots.
 */
function orderedChildren(
  data: ProjectTreeData,
  projectId: string,
  placeholders: readonly UnsupportedContainerWire[],
): ExplorerNode[] {
  return [
    ...EXPLORER_TREES.flatMap((tree) => tree.containers(data)),
    // A placeholder keeps its place among the containers; one with no recorded order goes last.
    ...placeholders.map((placeholder) => ({
      order: placeholder.order ?? Number.MAX_SAFE_INTEGER,
      node: placeholderNode(projectId, placeholder),
    })),
  ]
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.node);
}

/**
 * A container of a kind that is off or unknown (kind modules spec §7.2): a row labelled with its name
 * (or slug), with no children, that says why it cannot be opened, renamed, moved or deleted.
 */
function placeholderNode(projectId: string, placeholder: UnsupportedContainerWire): ExplorerNode {
  return {
    id: `placeholder:${projectId}:${placeholder.dir}/${placeholder.slug}`,
    kind: 'placeholder',
    label: placeholder.name ?? placeholder.slug,
    projectId,
    placeholderKind: placeholder.kind,
    message: placeholderMessage(placeholder.kind, placeholder.reason),
  };
}

/**
 * A project's Sequences group, after its interfaces and APIs: sequences have an ordering of their
 * own, not the containers' shared one. None when the project has no sequence.
 */
function sequencesGroup(projectId: string, sequences: readonly ExplorerSequence[]): ExplorerNode[] {
  if (sequences.length === 0) {
    return [];
  }
  return [
    {
      id: `sequences:${projectId}`,
      kind: 'sequences',
      label: 'Sequences',
      projectId,
      children: sequences.map((sequence) => ({
        id: `sequence:${sequence.id}`,
        kind: 'sequence' as const,
        label: sequence.name,
        projectId,
        sequenceId: sequence.id,
      })),
    },
  ];
}

/** A project's Mocks group, after its sequences. None when the project has no mock. */
function mocksGroup(projectId: string, mocks: readonly ExplorerMock[]): ExplorerNode[] {
  if (mocks.length === 0) {
    return [];
  }
  return [
    {
      id: `mocks:${projectId}`,
      kind: 'mocks',
      label: 'Mocks',
      projectId,
      children: mocks.map((mock) => ({
        id: `mock:${mock.id}`,
        kind: 'mock' as const,
        label: mock.name,
        projectId,
        mockId: mock.id,
      })),
    },
  ];
}

/** The containers **Switch on scripts…** is offered on. */
const SCRIPT_CONTAINERS: ReadonlySet<ExplorerNodeKind> = new Set(
  EXPLORER_TREES.flatMap((tree) => tree.scriptContainers ?? []),
);

/** The id of the interface, API or folder a container node stands for, whose scripts it carries (#334). */
function levelIdOf(node: ExplorerNode): string | undefined {
  return SCRIPT_CONTAINERS.has(node.kind) ? (node.folderId ?? node.interfaceId ?? node.apiId) : undefined;
}

/** The ids of `node`'s own scripts and those of the requests and levels under it, where they are off. */
function scriptsOffAt(node: ExplorerNode, off: ReadonlySet<string>): string[] {
  const own = node.requestId ?? levelIdOf(node);
  return [
    ...(own !== undefined && off.has(own) ? [own] : []),
    ...(node.children ?? []).flatMap((child) => scriptsOffAt(child, off)),
  ];
}

/** `node` with {@link ExplorerNode.scriptsOff} set on it and on every container beneath it. */
function withScriptsOff(node: ExplorerNode, off: ReadonlySet<string>): ExplorerNode {
  const children = node.children?.map((child) => withScriptsOff(child, off));
  const ids = SCRIPT_CONTAINERS.has(node.kind) ? [...new Set(scriptsOffAt(node, off))] : [];
  if (children === undefined && ids.length === 0) {
    return node;
  }
  return { ...node, ...(children !== undefined ? { children } : {}), ...(ids.length > 0 ? { scriptsOff: ids } : {}) };
}

/**
 * A project's Values group, last: the session values single sends' scripts set, masked by main, a
 * secret one shown without its value. None when there are none.
 */
function valuesGroup(projectId: string, values: readonly ScriptValueWire[]): ExplorerNode[] {
  if (values.length === 0) {
    return [];
  }
  return [
    {
      id: `values:${projectId}`,
      kind: 'values',
      label: 'Values',
      projectId,
      children: values.map((value) => ({
        id: `value:${projectId}:${value.name}`,
        kind: 'value' as const,
        label: value.secret ? `${value.name} (secret)` : `${value.name} = ${value.value ?? ''}`,
        projectId,
      })),
    },
  ];
}

/** Each kind's movable rows, and the id a `move-node` mutation addresses each by. */
const MOVABLE: Partial<Record<ExplorerNodeKind, 'apiId' | 'folderId' | 'requestId'>> = Object.fromEntries(
  EXPLORER_TREES.flatMap((tree) => Object.entries(tree.movable ?? {})),
);

/**
 * The entity id a `move-node` mutation addresses for one row, or `undefined` for a row that cannot
 * be moved — an interface, an operation, a project, or a SOAP request, none of which the
 * container ordering applies to.
 */
export function restEntityId(node: ExplorerNode | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  const field =
    node.kind === 'webhook-folder' ? 'folderId' : node.kind === 'webhook-request' ? 'requestId' : MOVABLE[node.kind];
  return field === undefined ? undefined : node[field];
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
