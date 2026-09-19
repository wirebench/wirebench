/**
 * One WebSocket request tab: its path line and connect strip on top, the request tabs, and the
 * session pane beside or under them.
 *
 * The same shape as the gRPC editor. Everything it needs is read from the stores by id, and every
 * edit is *staged* (`editWsRequest`) rather than written, so the tab carries an unsaved dot and
 * `Mod+S` writes one request's worth of work — saved messages included. The URL the strip shows
 * comes from main's own dry run (`request.preflightWs`), because only main knows the active
 * environment. Params, Headers and Auth are the REST editor's own tabs, used as they are.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Breadcrumb } from '../../components/breadcrumb.js';
import { Tabs } from '../../components/tabs.js';
import { shortcutFor } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { folderChainOf, useProjectStore, wsDraftPatch } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { groupOrientation, useEditorLayout } from '../request-editor/layout.js';
import { RestAuthTab } from '../rest-editor/auth-tab.js';
import { HeadersTab } from '../rest-editor/headers-tab.js';
import { ParamsTab } from '../rest-editor/params-tab.js';
import type { AuthConfigWire, WsRequestPatchWire, WsSavedMessageWire } from '../../../shared/wire-types.js';
import { WsBadge } from './badge.js';
import { WsConnectBar } from './connect-bar.js';
import { WsMessagesTab } from './messages-tab.js';
import { WsResponsePane } from './response-pane.js';
import { WsSettingsTab } from './settings-tab.js';
import { WsSubprotocolsTab } from './subprotocols-tab.js';
import { sendWsComposed, useWsSelectionStore } from './ws-session-actions.js';

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/** The request tabs, in order. */
const TABS = [
  { id: 'messages', label: 'Messages' },
  { id: 'params', label: 'Params' },
  { id: 'headers', label: 'Headers' },
  { id: 'subprotocols', label: 'Subprotocols' },
  { id: 'auth', label: 'Auth' },
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** How long to wait after an edit before asking main where the session would go. */
const PREFLIGHT_DEBOUNCE_MS = 250;

/** A REST headers tab has no body to compute a content type from; a handshake has none. */
const NO_BODY = { kind: 'none' } as const;

export interface WsEditorProps {
  readonly requestId: string;
}

/** The path line for one WebSocket request. */
function WsBreadcrumb({ requestId }: { readonly requestId: string }) {
  const request = useProjectStore((state) => state.wsRequests[requestId]);
  const projectName = useProjectStore((state) => {
    const projectId = state.projectOf[requestId];
    return projectId === undefined ? undefined : state.projects[projectId]?.name;
  });
  const apiName = useProjectStore((state) => (request === undefined ? undefined : state.wsApis[request.apiId]?.name));
  const folderMap = useProjectStore((state) => state.folders);
  const folders = useMemo(() => folderChainOf(folderMap, request?.folderId), [folderMap, request?.folderId]);
  if (request === undefined) {
    return null;
  }
  const trail = [projectName, apiName, ...folders.map((folder) => folder.name)].filter(
    (segment): segment is string => segment !== undefined && segment.length > 0,
  );
  return (
    <Breadcrumb
      label="Request path"
      testidPrefix="ws-breadcrumb"
      trail={trail}
      name={request.name}
      onRename={(name) => {
        void useProjectStore.getState().updateWsRequest(requestId, { name });
      }}
      badge={<WsBadge />}
    />
  );
}

/** One WebSocket request's editor. */
export function WsEditor({ requestId }: WsEditorProps) {
  const request = useProjectStore((state) => state.wsRequests[requestId]);
  const api = useProjectStore((state) => (request === undefined ? undefined : state.wsApis[request.apiId]));
  const folderMap = useProjectStore((state) => state.folders);
  const folders = useMemo(() => folderChainOf(folderMap, request?.folderId), [folderMap, request?.folderId]);
  const editWsRequest = useProjectStore((state) => state.editWsRequest);
  const session = useExchangesStore((state) => state.wsByRequest[requestId]);
  const connectWs = useExchangesStore((state) => state.connectWs);
  const cancelWs = useExchangesStore((state) => state.cancelWs);
  const disconnectWs = useExchangesStore((state) => state.disconnectWs);
  const preferences = usePreferencesStore((state) => state.preferences);
  const activeEnvironment = useWorkspaceStore((state) => state.workspace?.activeEnvironmentId);
  const selectedMessageId = useWsSelectionStore((state) => state.selected[requestId]);
  const selectMessage = useWsSelectionStore((state) => state.select);
  const layout = useEditorLayout(requestId);
  const [tab, setTab] = useState<TabId>('messages');
  const [resolved, setResolved] = useState<{ url?: string; source?: string; problem?: string }>({});
  const platform = useMemo(() => detectPlatform(), []);

  const apiUrl = api?.url ?? '';
  const requestUrl = request?.url ?? '';
  const queryKey = JSON.stringify(request?.query ?? []);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const draft = wsDraftPatch(requestId);
      void ipc()
        .request.preflightWs({ requestId, ...(draft !== undefined ? { draft } : {}) })
        .then((result) => {
          if (cancelled) return;
          setResolved(
            result.ok
              ? {
                  ...(result.value.endpoint !== undefined ? { url: result.value.endpoint } : {}),
                  source: result.value.endpointSource,
                }
              : { problem: result.error.message },
          );
        });
    }, PREFLIGHT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requestId, apiUrl, requestUrl, queryKey, activeEnvironment]);

  const stage = useCallback(
    (patch: WsRequestPatchWire) => {
      editWsRequest(requestId, patch);
    },
    [editWsRequest, requestId],
  );

  const onSave = useCallback(() => {
    void useProjectStore.getState().saveWsRequest(requestId);
  }, [requestId]);

  const onSendSaved = useCallback(
    (message: WsSavedMessageWire) => {
      void sendWsComposed(requestId, {
        format: message.format,
        content: message.content,
        expand: message.format === 'text',
      });
    },
    [requestId],
  );

  if (request === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const open = session?.status === 'open';
  const orientation = groupOrientation(layout);
  const inheritedAuth = [...folders]
    .reverse()
    .find((folder) => folder.auth !== undefined && folder.auth.type !== 'inherit');
  const inheritedFrom =
    inheritedAuth?.auth !== undefined
      ? { label: inheritedAuth.name, type: inheritedAuth.auth.type }
      : api?.auth !== undefined && api.auth.type !== 'inherit'
        ? { label: api.name, type: api.auth.type }
        : undefined;

  const requestTabs = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Tabs label="Request tabs" items={TABS} active={tab} onSelect={setTab} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === 'messages' && (
          <WsMessagesTab
            messages={request.messages}
            selectedId={selectedMessageId}
            onSelect={(messageId) => {
              selectMessage(requestId, messageId);
            }}
            onChange={(messages) => {
              stage({ messages });
            }}
            open={open}
            onSend={onSendSaved}
            onSave={onSave}
          />
        )}
        {tab === 'params' && (
          <ParamsTab
            url={request.url}
            pathParams={[]}
            query={request.query}
            onChange={(patch) => {
              stage({
                ...(patch.query !== undefined ? { query: patch.query } : {}),
                ...(patch.url !== undefined ? { url: patch.url } : {}),
              });
            }}
          />
        )}
        {tab === 'headers' && (
          <HeadersTab
            headers={request.headers}
            body={NO_BODY}
            onChange={(patch) => {
              if (patch.headers !== undefined) stage({ headers: patch.headers });
            }}
          />
        )}
        {tab === 'subprotocols' && <WsSubprotocolsTab subprotocols={request.subprotocols} onChange={stage} />}
        {tab === 'auth' && (
          <RestAuthTab
            requestId={requestId}
            auth={request.auth}
            inheritedFrom={inheritedFrom}
            onChange={(auth: AuthConfigWire) => {
              stage({ auth });
            }}
          />
        )}
        {tab === 'settings' && (
          <WsSettingsTab
            settings={request.settings}
            inheritedTimeoutMs={preferences.http.socketTimeoutMs}
            onChange={stage}
          />
        )}
      </div>
    </div>
  );

  const responsePane = (
    <WsResponsePane
      state={session}
      onSend={(message) => sendWsComposed(requestId, message)}
      sendShortcut={shortcutFor('ws.connect', platform)}
    />
  );

  return (
    <section aria-label={`Request ${request.name}`} data-testid="ws-editor" className="flex h-full min-h-0 flex-col">
      <WsBreadcrumb requestId={requestId} />
      <WsConnectBar
        url={resolved.url}
        urlSource={resolved.source}
        urlProblem={resolved.problem}
        status={session?.status}
        closeCode={session?.exchange?.closed.code}
        trustInvalid={request.settings.trustInvalid === true}
        onConnect={() => {
          void connectWs(requestId);
        }}
        onCancel={() => {
          void cancelWs(requestId);
        }}
        onDisconnect={(code, reason) => {
          void disconnectWs(requestId, code, reason);
        }}
        connectShortcut={shortcutFor('ws.connect', platform)}
      />

      {layout.mode === 'tabs' ? (
        requestTabs
      ) : (
        <Group
          orientation={orientation}
          className={`flex min-h-0 flex-1 ${orientation === 'horizontal' ? '' : 'flex-col'}`}
        >
          <Panel id="ws-request-pane" defaultSize="50%" minSize="20%">
            {requestTabs}
          </Panel>
          <Separator aria-label="Resize" className={`${SEPARATOR} ${orientation === 'horizontal' ? 'w-px' : 'h-px'}`} />
          <Panel id="ws-response-pane" minSize="20%">
            {responsePane}
          </Panel>
        </Group>
      )}
    </section>
  );
}
