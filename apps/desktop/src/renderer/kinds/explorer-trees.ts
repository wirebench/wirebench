/** Every kind's tree contribution, in the explorer's tie-break order (spec §6.1). */
import type { KindExplorerTree } from './explorer-tree.js';
import { grpcExplorerTree } from './grpc/explorer-tree.js';
import { restExplorerTree } from './rest/explorer-tree.js';
import { soapExplorerTree } from './soap/explorer-tree.js';
import { wsExplorerTree } from './ws/explorer-tree.js';
import { mcpExplorerTree } from './mcp/explorer-tree.js';

export const EXPLORER_TREES: readonly KindExplorerTree[] = [
  soapExplorerTree,
  restExplorerTree,
  grpcExplorerTree,
  wsExplorerTree,
  mcpExplorerTree,
];
