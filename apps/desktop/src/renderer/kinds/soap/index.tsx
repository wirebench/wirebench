import { lazy } from 'react';
import type { RendererKind } from '../renderer-kind.js';
import { registerSoapCommands } from './commands.js';
import { soapRequests, soapHistory, soapSearch } from './activity.js';
import { soapExplorer } from './explorer.js';

// Monaco is by far the heaviest thing the renderer loads, so the request editor — the only
// thing that pulls it in — is split out and fetched the first time a request tab is opened.
const RequestEditor = lazy(async () => {
  // The request's variables, for completion, hover and the unresolved marks in every field (#340).
  const [module, { VariableAssistProvider }] = await Promise.all([
    import('../../features/request-editor/request-editor.js'),
    import('../../features/environments/variable-assist-provider.js'),
  ]);
  return {
    default: ({ id }: { readonly id: string }) => (
      <VariableAssistProvider requestId={id}>
        <module.RequestEditor requestId={id} />
      </VariableAssistProvider>
    ),
  };
});

const InterfaceEditor = lazy(async () => {
  const module = await import('../../features/interface-editor/interface-editor.js');
  return { default: ({ id }: { readonly id: string }) => <module.InterfaceEditor interfaceId={id} /> };
});

/** SOAP in the renderer: its request editor and its interface viewer. */
export const soapRenderer: RendererKind = {
  kind: 'soap',
  explorer: soapExplorer,
  requests: soapRequests,
  history: soapHistory,
  search: soapSearch,
  registerCommands: registerSoapCommands,
  tabs: [
    {
      kind: 'request',
      treeNode: (id) => `req:${id}`,
      idField: 'requestId',
      prefix: 'request:',
      persisted: true,
      Component: RequestEditor,
      title: (id, { project }) => project.requests[id]?.name,
      // Generated requests all start as "Request 1"; the operation tells them apart.
      detail: (id, { project }) => project.requests[id]?.operationName,
      dirty: (id, drafts) => drafts.requests[id] !== undefined,
    },
    {
      kind: 'interface',
      treeNode: (id) => `iface:${id}`,
      idField: 'interfaceId',
      prefix: 'interface:',
      persisted: true,
      Component: InterfaceEditor,
      title: (id, { project }) => project.interfaces[id]?.name,
    },
  ],
};
