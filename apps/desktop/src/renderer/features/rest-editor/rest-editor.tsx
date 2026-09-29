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
 *
 * A webhook item (`request.apiId` starting with `webhooks:`) is a REST request on the wire, so it
 * opens here unchanged rather than in a tab kind of its own; only the URL bar's base and the line
 * under it differ, since a webhook item has no API to read a base URL from — see
 * `webhook-url-note.tsx`.
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
import type { AuthConfigWire, RequestPreflightResponse, RestRequestPatchWire } from '../../../shared/wire-types.js';
import { explorerActions } from '../explorer/explorer-actions.js';
import { WebhookUrlNote } from '../webhook-items/webhook-url-note.js';
import { RestAuthTab } from './auth-tab.js';
import { BodyTab } from './body-tab.js';
import { HeadersTab } from './headers-tab.js';
import { ParamsTab } from './params-tab.js';
import { RestBreadcrumb } from './rest-breadcrumb.js';
import { restSendBlocked, setRestSendBlocked } from './send-blocked.js';
import { SettingsTab } from './settings-tab.js';
import { RestResponsePane } from './response/response-pane.js';
import { UrlBar } from './url-bar.js';
import { SendToEnvironmentsButton } from '../multi-env/send-to-environments-button.js';
import { hasScripts, ScriptsTab } from '../scripts/scripts-tab.js';

/** The two webhook-target error codes `request.preflightRest` refuses a webhook item's send with. */
const WEBHOOK_TARGET_ERROR_CODES = new Set(['webhook-target-missing', 'webhook-target-invalid']);

/** Whether a REST request id names a webhook item rather than an ordinary REST request. */
function isWebhookRequest(apiId: string | undefined): boolean {
  return apiId?.startsWith('webhooks:') === true;
}

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/** The request tabs, in order. */
const TABS = [
  { id: 'params', label: 'Params' },
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
  { id: 'auth', label: 'Auth' },
  { id: 'scripts', label: 'Scripts' },
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

/** What the preflight effect keeps: a resolved endpoint, or a webhook target error. */
interface PreflightState {
  readonly endpoint?: string | undefined;
  readonly source?: string | undefined;
  readonly target?: RequestPreflightResponse['target'] | undefined;
  readonly targetErrorCode?: string | undefined;
}

/** One REST request's editor. */
export function RestEditor({ requestId }: RestEditorProps) {
  const request = useProjectStore((state) => state.restRequests[requestId]);
  const isWebhookItem = isWebhookRequest(request?.apiId);
  const api = useProjectStore((state) => selectApiOf(state, requestId));
  const webhookCollection = useProjectStore((state) => {
    const projectId = state.projectOf[requestId];
    return isWebhookItem && projectId !== undefined ? state.webhooks[projectId] : undefined;
  });
  const projectId = useProjectStore((state) => state.projectOf[requestId]);
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
  const [resolved, setResolved] = useState<PreflightState>({});
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
          if (cancelled) {
            return;
          }
          if (result.ok) {
            setResolved({
              endpoint: result.value.endpoint,
              source: result.value.endpointSource,
              target: result.value.target,
            });
          } else if (WEBHOOK_TARGET_ERROR_CODES.has(result.error.code)) {
            // The two webhook-target refusals never carry a value — there is nowhere for this
            // send to go — so the editor reads the error itself rather than the usual result.
            setResolved({ targetErrorCode: result.error.code });
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

  // A webhook item has no target-missing note until the user has set one, and no inline error
  // until the target resolves to something that is not `http(s)` — the two `webhook-target-*`
  // refusals `preflightRest` reports as an IPC error rather than in its usual value.
  const sendDisabledReason =
    isWebhookItem && resolved.targetErrorCode === 'webhook-target-missing' ? 'Set the Webhooks target' : undefined;
  useEffect(() => {
    setRestSendBlocked(requestId, sendDisabledReason);
    return () => {
      setRestSendBlocked(requestId, undefined);
    };
  }, [requestId, sendDisabledReason]);

  const onSend = useCallback(() => {
    // Enter in the URL field reaches here too: a send already in flight is stopped, not doubled,
    // and one the disabled Send button refuses is refused here as well.
    if (
      useExchangesStore.getState().restByRequest[requestId]?.status === 'sending' ||
      restSendBlocked(requestId) !== undefined
    ) {
      return;
    }
    void sendRest(requestId);
  }, [sendRest, requestId]);

  if (request === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const sending = exchange?.status === 'sending';
  const orientation = groupOrientation(layout);
  const relative = !isAbsoluteUrl(request.url);
  const invalidTargetMessage =
    isWebhookItem && resolved.targetErrorCode === 'webhook-target-invalid'
      ? 'The Webhooks target must start with http:// or https://'
      : undefined;
  const webhookNoteSource: 'target' | 'callback' | 'callback-fallback' | 'missing' =
    sendDisabledReason !== undefined ? 'missing' : (resolved.target?.source ?? 'target');
  // The folder an imported group's requests hang off; its name is what the header chip shows.
  const webhookGroup = isWebhookItem ? folders.find((folder) => folder.source !== undefined) : undefined;
  const inheritedAuth = [...folders]
    .reverse()
    .find((folder) => folder.auth !== undefined && folder.auth.type !== 'inherit');
  // Above the folders: the API's own credentials, or for a webhook item the collection's.
  const topAuth = isWebhookItem
    ? webhookCollection?.auth !== undefined
      ? { label: 'Webhooks', auth: webhookCollection.auth }
      : undefined
    : api?.auth !== undefined
      ? { label: api.name, auth: api.auth }
      : undefined;
  const inheritedFrom =
    inheritedAuth?.auth !== undefined
      ? { label: inheritedAuth.name, type: inheritedAuth.auth.type }
      : topAuth !== undefined && topAuth.auth.type !== 'inherit'
        ? { label: topAuth.label, type: topAuth.auth.type }
        : undefined;

  const requestTabs = (
    // `h-full`, not `flex-1`: the panel this sits in is a plain block, so a flex child of it would
    // size to its content and the raw body's editor would collapse to nothing.
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Tabs
        label="Request tabs"
        items={TABS.map((item) =>
          item.id === 'scripts' && hasScripts(request.scripts) ? { ...item, badge: '●' } : item,
        )}
        active={tab}
        onSelect={setTab}
      />
      {/* A flex column, so a tab that fills the pane (the raw body's editor) is given a height
          rather than collapsing to its content. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === 'params' && (
          <ParamsTab url={request.url} pathParams={request.pathParams} query={request.query} onChange={stage} />
        )}
        {tab === 'headers' && <HeadersTab headers={request.headers} body={request.body} onChange={stage} />}
        {tab === 'body' && (
          <BodyTab
            requestId={requestId}
            method={request.method}
            url={request.url}
            body={request.body}
            settings={request.settings}
            onChange={stage}
            onSend={onSend}
            onSave={() => {
              void useProjectStore.getState().saveRestRequest(requestId, { manual: true });
            }}
          />
        )}
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
        {tab === 'scripts' && <ScriptsTab requestId={requestId} scripts={request.scripts} />}
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

  const responsePane = <RestResponsePane state={exchange} requestId={requestId} />;

  return (
    <section aria-label={`Request ${request.name}`} data-testid="rest-editor" className="flex h-full min-h-0 flex-col">
      <RestBreadcrumb requestId={requestId} />
      {isWebhookItem && (
        <div className="flex h-6 shrink-0 items-center border-b border-hairline bg-surface-base px-3">
          <span data-testid="webhook-chip" className="rounded bg-surface-raised px-1.5 py-0.5 text-2xs text-fg-subtle">
            {webhookGroup !== undefined ? `webhook · ${webhookGroup.name}` : 'webhook'}
          </span>
        </div>
      )}
      <UrlBar
        method={request.method}
        url={request.url}
        // A webhook item has no API, so its base is never read from one — the target it would
        // actually go to (or nothing, while unresolved) stands in, under the `baseLabel` prefix.
        basePrefix={isWebhookItem ? resolved.endpoint : relative ? (api?.baseUrl ?? undefined) : undefined}
        baseLabel={isWebhookItem ? 'Target' : undefined}
        baseSource={isWebhookItem ? undefined : baseSourceLabel(resolved.source)}
        sending={sending}
        live={exchange?.live !== undefined}
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
        sendDisabledReason={sendDisabledReason}
        menu={<SendToEnvironmentsButton requestId={requestId} kind="rest" />}
      />
      {isWebhookItem && (
        <>
          {invalidTargetMessage !== undefined && (
            <p role="alert" className="border-b border-hairline bg-surface-base px-3 py-1 text-xs text-status-danger">
              {invalidTargetMessage}
            </p>
          )}
          <WebhookUrlNote
            resolvedUrl={resolved.endpoint}
            source={webhookNoteSource}
            detail={resolved.target?.detail}
            onOpenSettings={() => {
              explorerActions.openWebhookSettings(projectId, request.folderId);
            }}
          />
        </>
      )}

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
