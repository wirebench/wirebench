/**
 * What each kind adds to one project's explorer tree (kind modules spec §6.1): its containers and
 * everything under them. Pure, with no React and no store, so `tree-nodes.ts` and its tests can use
 * it without loading the kinds' editors.
 */
import type { KindId } from '../../shared/kinds/kind-module.js';
import type { InterfaceSummary } from '../../shared/kinds/soap/wire.js';
import type {
  ExplorerConflictTargets,
  ExplorerGrpcData,
  ExplorerMcpData,
  ExplorerNode,
  ExplorerNodeKind,
  ExplorerRestData,
  ExplorerWsData,
} from '../features/explorer/tree-nodes.js';
import type { RequestDraft } from '../state/project.js';

/** One project's data, as the tree builder holds it. */
export interface ProjectTreeData {
  /** The project's interfaces, in its own order. */
  readonly interfaces: readonly InterfaceSummary[];
  /** Every open project's SOAP requests. */
  readonly requests: readonly RequestDraft[];
  readonly conflicted: ExplorerConflictTargets;
  readonly rest: ExplorerRestData | undefined;
  readonly grpc: ExplorerGrpcData | undefined;
  readonly ws: ExplorerWsData | undefined;
  readonly mcp: ExplorerMcpData | undefined;
}

/** A container row and its place in the project's shared `order` space. */
export interface OrderedNode {
  readonly order: number;
  readonly node: ExplorerNode;
}

export interface KindExplorerTree {
  readonly kind: KindId;
  containers(data: ProjectTreeData): readonly OrderedNode[];
  /** The kind's rows **Switch on scripts…** is offered on. */
  readonly scriptContainers?: readonly ExplorerNodeKind[];
  /** The kind's rows a `move-node` mutation can move, and the id it addresses each by. */
  readonly movable?: Partial<Record<ExplorerNodeKind, 'apiId' | 'folderId' | 'requestId'>>;
}
