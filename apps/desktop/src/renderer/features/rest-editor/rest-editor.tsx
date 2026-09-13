/**
 * One REST request tab: its path line and URL bar on top, the request tabs below, and the response
 * beside or under them.
 *
 * Everything it needs is read from the stores by id, so a tab is fully described by its request id.
 * Every edit is *staged* (`editRestRequest`) rather than written: the tab carries an unsaved dot and
 * `Mod+S` has one request's worth of work to write, exactly as a SOAP request does.
 *
 * The URL bar's greyed base prefix and the resolved URL come from main's own dry run
 * (`request.preflightRest`), because only main knows the active environment and the API's servers.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Tabs } from '../../components/tabs.js';
import { shortcutFor } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { folderChainOf, selectApiOf, useProjectStore } from '../../state/project.js';
import { isAbsoluteUrl, queryFromUrl, syncPathParams } from '../../state/rest-url.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { groupOrientation, useEditorLayout } from '../request-editor/layout.js';
import type { AuthConfigWire, RestRequestPatchWire } from '../../../shared/wire-types.js';
import { RestAuthTab } from './auth-tab.js';
import { BodyTab } from './body-tab.js';
import { HeadersTab } from './headers-tab.js';
import { ParamsTab } from './params-tab.js';
import { RestBreadcrumb } from './rest-breadcrumb.js';
import { SettingsTab } from './settings-tab.js';
import { UrlBar } from './url-bar.js';

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/** The request tabs, in order. */
const TABS = [
  { id: 'params', label: 'Params' },
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
  { id: 'auth', label: 'Auth' },
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** How long to wait after a URL keystroke before asking main where the request would go. */
const PREFLIGHT_DEBOUNCE_MS = 250;

export interface RestEditorProps {
  readonly requestId: string;
}

/** Where a base URL came from, as the badge reads it. */
function baseSourceLabel(source: string | undefined): string | undefined {
  if (source === undefined || source === 'none') {
    return undefined;
  }
  return source === 'interface-default' ? 'API' : source;
}

/** One REST request's editor. */
export function RestEditor({ requestId }: RestEditorProps) {
  const request = useProjectStore((state) => state.restRequests[requestId]);
  const api = useProjectStore((state) => selectApiOf(state, requestId));
  // The map, then the chain in a memo: the chain is a fresh array, and building one inside a
  // selector would hand React a new reference on every render.
  const folderMap = useProjectStore((state) => state.folders);
  const folders = useMemo(() => folderChainOf(folderMap, request?.folderId), [folderMap, request?.folderId]);
  const editRestRequest = useProjectStore((state) => state.editRestRequest);
  const exchange = useExchangesStore((state) => state.restByRequest[requestId]);
  const sendRest = useExchangesStore((state) => state.sendRest);
  const cancelRest = useExchangesStore((state) => state.cancelRest);
  const preferences = usePreferencesStore((state) => state.preferences);
  // A base URL can come from the active environment, which lives on the workspace, so an
  // environment switch has to re-run the preflight as well as a project change.
  const activeEnvironment = useWorkspaceStore((state) => state.workspace?.activeEnvironmentId);
  const layout = useEditorLayout(requestId);
  const [tab, setTab] = useState<TabId>('params');
  const [resolved, setResolved] = useState<{ endpoint?: string | undefined; source?: string | undefined }>({});
  const platform = useMemo(() => detectPlatform(), []);

  const url = request?.url ?? '';
  useEffect(() => {
    // Debounced because it runs on every keystroke in the URL field; the answer only ever feeds a
    // hint, so a stale one costs nothing and the last reply wins.
    let cancelled = false;
    const timer = setTimeout(() => {
      void ipc()
        .request.preflightRest({ requestId })
        .then((result) => {
          if (!cancelled && result.ok) {
            setResolved({ endpoint: result.value.endpoint, source: result.value.endpointSource });
          }
        });
    }, PREFLIGHT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requestId, url, activeEnvironment]);

  const stage = useCallback(
    (patch: RestRequestPatchWire) => {
      editRestRequest(requestId, patch);
    },
    [editRestRequest, requestId],
  );

  const onSend = useCallback(() => {
    void sendRest(requestId);
  }, [sendRest, requestId]);

  if (request === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const sending = exchange?.status === 'sending';
  const orientation = groupOrientation(layout);
  const relative = !isAbsoluteUrl(request.url);
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
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs label="Request tabs" items={TABS} active={tab} onSelect={setTab} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'params' && (
          <ParamsTab url={request.url} pathParams={request.pathParams} query={request.query} onChange={stage} />
        )}
        {tab === 'headers' && <HeadersTab headers={request.headers} body={request.body} onChange={stage} />}
        {tab === 'body' && <BodyTab body={request.body} settings={request.settings} onChange={stage} />}
        {tab === 'auth' && (
          <RestAuthTab
            auth={request.auth}
            inheritedFrom={inheritedFrom}
            onChange={(auth: AuthConfigWire) => {
              stage({ auth });
            }}
          />
        )}
        {tab === 'settings' && (
          <SettingsTab
            settings={request.settings}
            inherited={{
              timeoutMs: preferences.http.socketTimeoutMs,
              followRedirects: preferences.rest.followRedirects,
              maxRedirects: preferences.rest.maxRedirects,
              encodeUrl: true,
              sendCookies: true,
            }}
            onChange={stage}
          />
        )}
      </div>
    </div>
  );

  // The response pane arrives with the response task; until then the region says what is there so
  // the editor's shape is honest rather than empty.
  const responsePane = (
    <div data-testid="rest-response" className="flex h-full flex-col gap-1 p-3 text-sm">
      {exchange === undefined && <p className="text-fg-subtle">Send the request to see its response.</p>}
      {sending && <p className="text-fg-muted">Sending…</p>}
      {exchange?.status === 'error' && (
        <p className="text-status-danger">
          {exchange.error?.code}: {exchange.error?.message}
        </p>
      )}
      {exchange?.exchange !== undefined && (
        <p data-testid="rest-response-status" className="font-mono text-fg-default">
          {exchange.exchange.http.status} {exchange.exchange.http.statusText} ·{' '}
          {exchange.exchange.durationMs.toFixed(0)} ms
        </p>
      )}
    </div>
  );

  return (
    <section aria-label={`Request ${request.name}`} data-testid="rest-editor" className="flex h-full min-h-0 flex-col">
      <RestBreadcrumb requestId={requestId} />
      <UrlBar
        method={request.method}
        url={request.url}
        basePrefix={relative ? (api?.baseUrl ?? undefined) : undefined}
        baseSource={baseSourceLabel(resolved.source)}
        sending={sending}
        onMethodChange={(method) => {
          stage({ method });
        }}
        onUrlChange={(next) => {
          // The tables follow the URL, so the Params tab and the field can never disagree: a
          // `{param}` that is gone takes its row with it, and a query the user typed into the URL
          // appears in the table.
          stage({
            url: next,
            pathParams: [...syncPathParams(next, request.pathParams)],
            query: [...mergeQuery(next, request.query)],
          });
        }}
        onSend={onSend}
        onCancel={() => {
          void cancelRest(requestId);
        }}
        sendShortcut={shortcutFor('rest.send', platform)}
      />

      {layout.mode === 'tabs' ? (
        requestTabs
      ) : (
        <Group
          orientation={orientation}
          className={`flex min-h-0 flex-1 ${orientation === 'horizontal' ? '' : 'flex-col'}`}
        >
          <Panel id="rest-request-pane" defaultSize="50%" minSize="20%">
            {requestTabs}
          </Panel>
          <Separator aria-label="Resize" className={`${SEPARATOR} ${orientation === 'horizontal' ? 'w-px' : 'h-px'}`} />
          <Panel id="rest-response-pane" minSize="20%">
            {responsePane}
          </Panel>
        </Group>
      )}
    </section>
  );
}

/**
 * The query table a URL implies, keeping the rows the user switched off.
 *
 * A disabled row is not in the URL — the URL is what gets sent — so re-reading the URL would drop it.
 * Keeping it means a row can be toggled off and back on without retyping it, and the table stays the
 * request's stored query.
 */
export function mergeQuery(
  url: string,
  rows: readonly { readonly name: string; readonly value: string; readonly enabled: boolean }[],
): readonly { name: string; value: string; enabled: boolean }[] {
  const fromUrl = queryFromUrl(url).map((row) => ({ name: row.name, value: row.value, enabled: true }));
  const disabled = rows
    .filter((row) => !row.enabled)
    .map((row) => ({ name: row.name, value: row.value, enabled: false }));
  return [...fromUrl, ...disabled];
}
