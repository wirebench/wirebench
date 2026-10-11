import { lazy } from 'react';
import type { RendererKind } from '../renderer-kind.js';
import { registerWsCommands } from './commands.js';
import { wsRequests, wsHistory, wsSearch, wsLog } from './activity.js';
import { wsExplorer } from './explorer.js';

// Split out like the gRPC editor: its saved-message editor and frame viewer are Monaco.
const WsEditor = lazy(async () => {
  // The request's variables, for completion, hover and the unresolved marks in every field (#340).
  const [module, { VariableAssistProvider }] = await Promise.all([
    import('../../features/ws-editor/ws-editor.js'),
    import('../../features/environments/variable-assist-provider.js'),
  ]);
  return {
    default: ({ id }: { readonly id: string }) => (
      <VariableAssistProvider requestId={id}>
        <module.WsEditor requestId={id} />
      </VariableAssistProvider>
    ),
  };
});

const WsApiTab = lazy(async () => {
  const module = await import('../../features/ws-api/ws-api-tab.js');
  return { default: ({ id }: { readonly id: string }) => <module.WsApiTab apiId={id} /> };
});

/** WebSocket in the renderer: its request editor and its API tab. */
export const wsRenderer: RendererKind = {
  kind: 'websocket',
  explorer: wsExplorer,
  requests: wsRequests,
  history: wsHistory,
  search: wsSearch,
  registerCommands: registerWsCommands,
  log: wsLog,
  tabs: [
    {
      kind: 'ws-request',
      idField: 'wsRequestId',
      prefix: 'ws:',
      persisted: true,
      Component: WsEditor,
      title: (id, { project }) => project.wsRequests[id]?.name,
      dirty: (id, drafts) => drafts.wsRequests[id] !== undefined,
    },
    {
      kind: 'ws-api',
      idField: 'wsApiId',
      prefix: 'ws-api:',
      persisted: true,
      Component: WsApiTab,
      title: (id, { project }) => project.wsApis[id]?.name,
    },
  ],
};
