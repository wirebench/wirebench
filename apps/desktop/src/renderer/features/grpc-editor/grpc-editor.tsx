/**
 * One gRPC request tab: its path line and call strip on top, the request tabs below, and the
 * response beside or under them.
 *
 * Everything it needs is read from the stores by id, so a tab is fully described by its request id.
 * Every edit is *staged* (`editGrpcRequest`) rather than written: the tab carries an unsaved dot and
 * `Mod+S` has one request's worth of work to write, exactly as a REST request does.
 *
 * The services the method picker offers come from main's cached `.proto` set (`api.grpcDefinition`),
 * fetched once per API and kept while the tab lives; the resolved target comes from main's own dry
 * run (`request.preflightGrpc`), because only main knows the active environment.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { clientStreams } from '@wirebench/engine/grpc';
import { showToast } from '../../components/toast.js';
import { Tabs } from '../../components/tabs.js';
import { shortcutFor } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { folderChainOf, useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { groupOrientation, useEditorLayout } from '../request-editor/layout.js';
import { RestAuthTab } from '../rest-editor/auth-tab.js';
import type {
  AuthConfigWire,
  GrpcMethodDescriptorWire,
  GrpcRequestPatchWire,
  GrpcServiceDescriptorWire,
} from '../../../shared/wire-types.js';
import { CallBar } from './call-bar.js';
import { GrpcBreadcrumb } from './grpc-breadcrumb.js';
import { MessageTab } from './message-tab.js';
import { MetadataTab } from './metadata-tab.js';
import { GrpcResponsePane } from './response-pane.js';
import { GrpcSettingsTab } from './settings-tab.js';

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/** The request tabs, in order. */
const TABS = [
  { id: 'message', label: 'Message' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'auth', label: 'Auth' },
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** How long to wait after an edit before asking main where the call would go. */
const PREFLIGHT_DEBOUNCE_MS = 250;

export interface GrpcEditorProps {
  readonly requestId: string;
}

/** Whether a message text is still the blank a new request starts with, so a sample may replace it. */
export function isBlankMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || trimmed === '{}' || trimmed === '{\n}';
}

/**
 * The services of one API's definition, fetched once and shared by every tab on that API. An API
 * with no cached definition yields an empty list, which the call strip reads as "type it by hand".
 */
function useGrpcServices(apiId: string | undefined, definitionKey: string): GrpcServiceDescriptorWire[] | undefined {
  const [services, setServices] = useState<GrpcServiceDescriptorWire[] | undefined>(undefined);
  useEffect(() => {
    if (apiId === undefined) {
      setServices(undefined);
      return;
    }
    let live = true;
    setServices(undefined);
    void ipc()
      .api.grpcDefinition({ apiId })
      .then((result) => {
        if (!live) return;
        setServices(result.ok ? result.value.services : []);
      });
    return () => {
      live = false;
    };
    // `definitionKey` changes when the API's definition is (re)imported, which is when the list can change.
  }, [apiId, definitionKey]);
  return services;
}

/** One gRPC request's editor. */
export function GrpcEditor({ requestId }: GrpcEditorProps) {
  const request = useProjectStore((state) => state.grpcRequests[requestId]);
  const api = useProjectStore((state) => (request === undefined ? undefined : state.grpcApis[request.apiId]));
  const folderMap = useProjectStore((state) => state.folders);
  const folders = useMemo(() => folderChainOf(folderMap, request?.folderId), [folderMap, request?.folderId]);
  const editGrpcRequest = useProjectStore((state) => state.editGrpcRequest);
  const exchange = useExchangesStore((state) => state.grpcByRequest[requestId]);
  const sendGrpc = useExchangesStore((state) => state.sendGrpc);
  const cancelGrpc = useExchangesStore((state) => state.cancelGrpc);
  const pushGrpcMessage = useExchangesStore((state) => state.pushGrpcMessage);
  const halfCloseGrpc = useExchangesStore((state) => state.halfCloseGrpc);
  const preferences = usePreferencesStore((state) => state.preferences);
  const activeEnvironment = useWorkspaceStore((state) => state.workspace?.activeEnvironmentId);
  const layout = useEditorLayout(requestId);
  const [tab, setTab] = useState<TabId>('message');
  const [resolved, setResolved] = useState<{ target?: string | undefined; source?: string | undefined }>({});
  const platform = useMemo(() => detectPlatform(), []);
  const services = useGrpcServices(
    api?.id,
    api?.definition === undefined ? '' : `${api.definition.source}:${api.definition.roots.join(',')}`,
  );

  const target = api?.target ?? '';
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void ipc()
        .request.preflightGrpc({ requestId })
        .then((result) => {
          if (!cancelled && result.ok) {
            setResolved({ target: result.value.endpoint, source: result.value.endpointSource });
          }
        });
    }, PREFLIGHT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requestId, target, activeEnvironment]);

  const stage = useCallback(
    (patch: GrpcRequestPatchWire) => {
      editGrpcRequest(requestId, patch);
    },
    [editGrpcRequest, requestId],
  );

  const onSend = useCallback(() => {
    void sendGrpc(requestId);
  }, [sendGrpc, requestId]);

  const onOpenStream = useCallback(() => {
    void sendGrpc(requestId, { interactive: true });
  }, [sendGrpc, requestId]);

  const onPush = useCallback(
    (messageText: string) => {
      void pushGrpcMessage(requestId, messageText);
    },
    [pushGrpcMessage, requestId],
  );

  const onHalfClose = useCallback(() => {
    void halfCloseGrpc(requestId);
  }, [halfCloseGrpc, requestId]);

  const onSave = useCallback(() => {
    void useProjectStore.getState().saveGrpcRequest(requestId);
  }, [requestId]);

  if (request === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const described =
    services === undefined
      ? undefined
      : services
          .flatMap((service) => service.methods)
          .find((method) => method.service === request.service && method.name === request.method);

  /** Fetches the method's request-type sample and puts it in the message. */
  const loadSample = async (type: string): Promise<void> => {
    if (api === undefined) return;
    const result = await ipc().api.grpcSample({ apiId: api.id, type });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    stage({ message: result.value.text });
  };

  const onMethodChange = (method: GrpcMethodDescriptorWire): void => {
    stage({ service: method.service, method: method.name, methodKind: method.kind });
    // A blank message is filled in with the new method's skeleton; anything typed is kept, since
    // switching between two methods of the same request type should not throw the message away.
    if (isBlankMessage(request.message)) {
      void loadSample(method.requestType);
    }
  };

  const sending = exchange?.status === 'sending';
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
        {tab === 'message' && (
          <MessageTab
            message={request.message}
            methodKind={request.methodKind}
            requestType={described?.requestType}
            onChange={(message) => {
              stage({ message });
            }}
            onResetToSample={
              described === undefined
                ? undefined
                : () => {
                    void loadSample(described.requestType);
                  }
            }
            onSend={onSend}
            onSave={onSave}
          />
        )}
        {tab === 'metadata' && (
          <MetadataTab metadata={request.metadata} apiMetadata={api?.metadata ?? []} onChange={stage} />
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
        {tab === 'settings' && (
          <GrpcSettingsTab
            settings={request.settings}
            inherited={{ timeoutMs: preferences.http.socketTimeoutMs }}
            onChange={stage}
          />
        )}
      </div>
    </div>
  );

  const responsePane = <GrpcResponsePane state={exchange} onPush={onPush} onHalfClose={onHalfClose} />;

  return (
    <section aria-label={`Request ${request.name}`} data-testid="grpc-editor" className="flex h-full min-h-0 flex-col">
      <GrpcBreadcrumb requestId={requestId} />
      <CallBar
        service={request.service}
        method={request.method}
        services={services}
        target={resolved.target ?? (target === '' ? undefined : target)}
        targetSource={resolved.source}
        tls={api?.tls ?? false}
        sending={sending}
        onMethodChange={onMethodChange}
        onManualChange={(service, method) => {
          stage({ service, method });
        }}
        onSend={onSend}
        onCancel={() => {
          void cancelGrpc(requestId);
        }}
        sendShortcut={shortcutFor('grpc.send', platform)}
        {...(clientStreams(request.methodKind) ? { onOpenStream } : {})}
      />

      {layout.mode === 'tabs' ? (
        requestTabs
      ) : (
        <Group
          orientation={orientation}
          className={`flex min-h-0 flex-1 ${orientation === 'horizontal' ? '' : 'flex-col'}`}
        >
          <Panel id="grpc-request-pane" defaultSize="50%" minSize="20%">
            {requestTabs}
          </Panel>
          <Separator aria-label="Resize" className={`${SEPARATOR} ${orientation === 'horizontal' ? 'w-px' : 'h-px'}`} />
          <Panel id="grpc-response-pane" minSize="20%">
            {responsePane}
          </Panel>
        </Group>
      )}
    </section>
  );
}
