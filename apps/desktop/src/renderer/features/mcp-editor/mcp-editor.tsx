/**
 * One MCP request tab (#79): its path line and operation strip on top, the request tabs, and the
 * response beside or under them.
 *
 * The same shape as the gRPC editor. Everything it needs is read from the stores by id, and every
 * edit is *staged* (`editMcpRequest`) rather than written, so the tab carries an unsaved dot and
 * `Mod+S` writes one request's worth of work. The tool and prompt pickers and the arguments'
 * completion come from the server's catalogue, which a refresh wrote into the mirror; a send goes to
 * main, which resolves the transport and asks for a stdio command line's approval.
 */
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Breadcrumb } from '../../components/breadcrumb.js';
import { Tabs } from '../../components/tabs.js';
import { shortcutFor } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import { useExchangesStore } from '../../state/exchanges.js';
import type { McpExchangeState } from '../../state/exchanges.js';
import { folderChainOf, useProjectStore } from '../../state/project.js';
import { assertionsBadge, AssertionsTab } from '../assertions/assertions-tab.js';
import { REQUEST_KINDS } from '../assertions/assertion-table.js';
import { groupOrientation, useEditorLayout } from '../request-editor/layout.js';
import { hasScripts, ScriptsTab } from '../scripts/scripts-tab.js';
import type { McpOperationWire, McpRequestPatchWire } from '../../../shared/kinds/mcp/wire.js';
import { ArgumentsTab } from './arguments-tab.js';
import { McpBadge } from './badge.js';
import { OperationBar } from './operation-bar.js';
import { McpSettingsTab } from './settings-tab.js';
import { mcpRecordOutcome } from './response/status-line.js';

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/** The request tabs, in order. */
const TABS = [
  { id: 'arguments', label: 'Arguments' },
  { id: 'assertions', label: 'Assertions' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export interface McpEditorProps {
  readonly requestId: string;
}

/** The path line for one MCP request. */
function McpBreadcrumb({ requestId }: { readonly requestId: string }) {
  const request = useProjectStore((state) => state.mcpRequests[requestId]);
  const projectName = useProjectStore((state) => {
    const projectId = state.projectOf[requestId];
    return projectId === undefined ? undefined : state.projects[projectId]?.name;
  });
  const serverName = useProjectStore((state) =>
    request === undefined ? undefined : state.mcpServers[request.apiId]?.name,
  );
  const folderMap = useProjectStore((state) => state.folders);
  const folders = useMemo(() => folderChainOf(folderMap, request?.folderId), [folderMap, request?.folderId]);
  if (request === undefined) {
    return null;
  }
  const trail = [projectName, serverName, ...folders.map((folder) => folder.name)].filter(
    (segment): segment is string => segment !== undefined && segment.length > 0,
  );
  return (
    <Breadcrumb
      label="Request path"
      testidPrefix="mcp-breadcrumb"
      trail={trail}
      name={request.name}
      onRename={(name) => {
        void useProjectStore.getState().updateMcpRequest(requestId, { name });
      }}
      badge={<McpBadge method={request.operation.method} />}
    />
  );
}

/** The one line a send's outcome reads as: OK, a tool error, a JSON-RPC error, or why it stopped. */
export function mcpOutcome(state: McpExchangeState | undefined): string | undefined {
  if (state === undefined) return undefined;
  if (state.status === 'sending') return 'Sending…';
  if (state.status === 'error') return state.error?.message ?? 'The send failed';
  const exchange = state.exchange;
  if (exchange === undefined) return undefined;
  if (exchange.failure !== undefined && exchange.error === undefined) return exchange.failure.message;
  return mcpRecordOutcome(exchange).text;
}

// Split out of the editor's chunk: the response pane is only drawn once there is something to show.
const McpResponsePane = lazy(async () => {
  const module = await import('./response/response-pane.js');
  return { default: module.McpResponsePane };
});

/** One MCP request's editor. */
export function McpEditor({ requestId }: McpEditorProps) {
  const request = useProjectStore((state) => state.mcpRequests[requestId]);
  const server = useProjectStore((state) => (request === undefined ? undefined : state.mcpServers[request.apiId]));
  const editMcpRequest = useProjectStore((state) => state.editMcpRequest);
  const exchange = useExchangesStore((state) => state.mcpByRequest[requestId]);
  const sendMcp = useExchangesStore((state) => state.sendMcp);
  const cancelMcp = useExchangesStore((state) => state.cancelMcp);
  const layout = useEditorLayout(requestId);
  const [tab, setTab] = useState<TabId>('arguments');
  const platform = useMemo(() => detectPlatform(), []);

  const stage = useCallback(
    (patch: McpRequestPatchWire) => {
      editMcpRequest(requestId, patch);
    },
    [editMcpRequest, requestId],
  );
  const stageOperation = useCallback(
    (operation: McpOperationWire) => {
      stage({ operation });
    },
    [stage],
  );
  const onSend = useCallback(() => {
    void sendMcp(requestId);
  }, [sendMcp, requestId]);
  const onSave = useCallback(() => {
    void useProjectStore.getState().saveMcpRequest(requestId, { manual: true });
  }, [requestId]);

  if (request === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const catalogue = server?.catalogue;
  const orientation = groupOrientation(layout);
  const assertionsCount = assertionsBadge(request.assertions);

  const requestTabs = (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Tabs
        label="Request tabs"
        items={TABS.map((item) =>
          item.id === 'scripts' && hasScripts(request.scripts)
            ? { ...item, badge: '●' }
            : item.id === 'assertions' && assertionsCount !== undefined
              ? { ...item, badge: assertionsCount }
              : item,
        )}
        active={tab}
        onSelect={setTab}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === 'arguments' && (
          <ArgumentsTab
            operation={request.operation}
            catalogue={catalogue}
            onChange={stageOperation}
            onSend={onSend}
            onSave={onSave}
          />
        )}
        {tab === 'assertions' && (
          <AssertionsTab key={requestId} requestId={requestId} assertions={request.assertions} kinds={REQUEST_KINDS} />
        )}
        {tab === 'scripts' && <ScriptsTab requestId={requestId} scripts={request.scripts} />}
        {tab === 'settings' && (
          <McpSettingsTab settings={request.settings} serverTimeoutMs={server?.settings.timeoutMs} onChange={stage} />
        )}
      </div>
    </div>
  );

  const responsePane = (
    <Suspense fallback={null}>
      <McpResponsePane state={exchange} transport={server?.transport.type} />
    </Suspense>
  );

  return (
    <section aria-label={`Request ${request.name}`} data-testid="mcp-editor" className="flex h-full min-h-0 flex-col">
      <McpBreadcrumb requestId={requestId} />
      <OperationBar
        operation={request.operation}
        catalogue={catalogue}
        sending={exchange?.status === 'sending'}
        onChange={stageOperation}
        onSend={onSend}
        onCancel={() => {
          void cancelMcp(requestId);
        }}
        sendShortcut={shortcutFor('mcp.send', platform)}
      />

      {layout.mode === 'tabs' ? (
        requestTabs
      ) : (
        <Group
          orientation={orientation}
          className={`flex min-h-0 flex-1 ${orientation === 'horizontal' ? '' : 'flex-col'}`}
        >
          <Panel id="mcp-request-pane" defaultSize="50%" minSize="20%">
            {requestTabs}
          </Panel>
          <Separator aria-label="Resize" className={`${SEPARATOR} ${orientation === 'horizontal' ? 'w-px' : 'h-px'}`} />
          <Panel id="mcp-response-pane" minSize="20%">
            {responsePane}
          </Panel>
        </Group>
      )}
    </section>
  );
}
