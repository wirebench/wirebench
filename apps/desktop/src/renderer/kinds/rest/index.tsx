import { lazy } from 'react';
import type { RendererKind } from '../renderer-kind.js';
import { requestContainer } from '../tab-contribution.js';
import { registerRestCommands } from './commands.js';
import { restRequests, restHistory, restSearch, restLog } from './activity.js';
import { restExplorer } from './explorer.js';

// Split out for the same reason as the SOAP editor: its raw-body editor is Monaco.
const RestEditor = lazy(async () => {
  // The request's variables, for completion, hover and the unresolved marks in every field (#340).
  const [module, { VariableAssistProvider }] = await Promise.all([
    import('../../features/rest-editor/rest-editor.js'),
    import('../../features/environments/variable-assist-provider.js'),
  ]);
  return {
    default: ({ id }: { readonly id: string }) => (
      <VariableAssistProvider requestId={id}>
        <module.RestEditor requestId={id} />
      </VariableAssistProvider>
    ),
  };
});

const ApiTab = lazy(async () => {
  const module = await import('../../features/rest-api/api-tab.js');
  return { default: ({ id }: { readonly id: string }) => <module.ApiTab apiId={id} /> };
});

/** REST in the renderer: its request editor and its API tab. */
export const restRenderer: RendererKind = {
  kind: 'rest',
  explorer: restExplorer,
  requests: restRequests,
  history: restHistory,
  search: restSearch,
  registerCommands: registerRestCommands,
  log: restLog,
  tabs: [
    {
      kind: 'rest-request',
      container: (id, project) =>
        requestContainer(project.restRequests[id], (apiId) => project.apis[apiId] !== undefined),
      idField: 'restRequestId',
      prefix: 'rest:',
      persisted: true,
      Component: RestEditor,
      title: (id, { project }) => project.restRequests[id]?.name,
      dirty: (id, drafts) => drafts.restRequests[id] !== undefined,
    },
    {
      kind: 'api',
      container: (id, project) => (project.apis[id] === undefined ? undefined : { apiId: id }),
      idField: 'apiId',
      prefix: 'api:',
      persisted: true,
      Component: ApiTab,
      title: (id, { project }) => project.apis[id]?.name,
    },
  ],
};
