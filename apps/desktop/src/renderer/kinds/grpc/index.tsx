import { lazy } from 'react';
import type { RendererKind } from '../renderer-kind.js';
import { requestContainer } from '../tab-contribution.js';
import { registerGrpcCommands } from './commands.js';
import { grpcRequests, grpcHistory, grpcSearch, grpcLog } from './activity.js';
import { grpcExplorer } from './explorer.js';

// Split out like the REST editor: its message editor is Monaco.
const GrpcEditor = lazy(async () => {
  // The request's variables, for completion, hover and the unresolved marks in every field (#340).
  const [module, { VariableAssistProvider }] = await Promise.all([
    import('../../features/grpc-editor/grpc-editor.js'),
    import('../../features/environments/variable-assist-provider.js'),
  ]);
  return {
    default: ({ id }: { readonly id: string }) => (
      <VariableAssistProvider requestId={id}>
        <module.GrpcEditor requestId={id} />
      </VariableAssistProvider>
    ),
  };
});

const GrpcApiTab = lazy(async () => {
  const module = await import('../../features/grpc-api/grpc-api-tab.js');
  return { default: ({ id }: { readonly id: string }) => <module.GrpcApiTab apiId={id} /> };
});

/** gRPC in the renderer: its request editor and its API tab. */
export const grpcRenderer: RendererKind = {
  kind: 'grpc',
  explorer: grpcExplorer,
  requests: grpcRequests,
  history: grpcHistory,
  search: grpcSearch,
  registerCommands: registerGrpcCommands,
  log: grpcLog,
  tabs: [
    {
      kind: 'grpc-request',
      treeNode: (id) => `grpc:${id}`,
      container: (id, project) =>
        requestContainer(project.grpcRequests[id], (apiId) => project.grpcApis[apiId] !== undefined),
      idField: 'grpcRequestId',
      prefix: 'grpc:',
      persisted: true,
      Component: GrpcEditor,
      title: (id, { project }) => project.grpcRequests[id]?.name,
      dirty: (id, drafts) => drafts.grpcRequests[id] !== undefined,
    },
    {
      kind: 'grpc-api',
      treeNode: (id) => `grpc-api:${id}`,
      container: (id, project) => (project.grpcApis[id] === undefined ? undefined : { apiId: id }),
      idField: 'grpcApiId',
      prefix: 'grpc-api:',
      persisted: true,
      Component: GrpcApiTab,
      title: (id, { project }) => project.grpcApis[id]?.name,
    },
  ],
};
