import { useCallback, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { shortcutFor } from '../../lib/keybindings.js';
import { detectPlatform } from '../../lib/platform.js';
import { useExchangesStore } from '../../state/exchanges.js';
import {
  selectRequestEndpointSource,
  selectRequestEndpointUrl,
  selectRequestTrustsInvalid,
} from '../../state/project-endpoint.js';
import { useProjectStore } from '../../state/project.js';
import { CloneRequestDialog } from './clone-request-dialog.js';
import { ImportCurlDialog } from './import-curl-dialog.js';
import { groupOrientation, useEditorLayout } from './layout.js';
import { RequestContextMenu } from './request-context-menu.js';
import { useRequestDialogsStore } from './request-dialogs.js';
import { RequestPane, type RequestPaneHandle } from './request-pane.js';
import { ViewTabs } from './view-tabs.js';
import { WssUsernameTokenDialog, WsTimestampDialog } from './wss-entry-dialogs.js';
import { ResponsePane } from './response-pane.js';
import { RequestToolbar } from './toolbar.js';
import { clearValidation, validateAndReport } from './validate-actions.js';

export interface RequestEditorProps {
  readonly requestId: string;
}

const PANE_TABS = [
  { id: 'request', label: 'Request' },
  { id: 'response', label: 'Response' },
] as const;

/** Mirrors `keybindings.ts`'s notion of "a keystroke the focused field should keep". */
function isTextInput(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable;
}

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/**
 * One request tab: toolbar on top, request and response panes below. Everything it needs is
 * read from the stores by id, so a tab is fully described by its `requestId`.
 */
export function RequestEditor({ requestId }: RequestEditorProps) {
  const layout = useEditorLayout(requestId);
  const [pane, setPane] = useState<(typeof PANE_TABS)[number]['id']>('request');
  const draft = useProjectStore((state) => state.requests[requestId]);
  const summary = useProjectStore((state) => (draft === undefined ? undefined : state.interfaces[draft.interfaceId]));
  const updateRequest = useProjectStore((state) => state.updateRequest);
  const setEndpoint = useProjectStore((state) => state.setEndpoint);
  const endpoint = useProjectStore((state) => selectRequestEndpointUrl(state, requestId));
  const endpointSource = useProjectStore((state) => selectRequestEndpointSource(state, requestId));
  const trustInvalid = useProjectStore((state) => selectRequestTrustsInvalid(state, requestId));
  const exchange = useExchangesStore((state) => state.byRequest[requestId]);
  const send = useExchangesStore((state) => state.send);
  const cancel = useExchangesStore((state) => state.cancel);

  // Clone and Import cURL are opened from the pane's context menu, the Code panel and the
  // palette, so the flag lives in a store; this editor owns the mounting for its own request.
  const dialog = useRequestDialogsStore((state) => (state.requestId === requestId ? state.kind : undefined));
  const closeDialog = useRequestDialogsStore((state) => state.close);

  const sending = exchange?.status === 'sending';
  const platform = useMemo(() => detectPlatform(), []);

  const requestPaneRef = useRef<RequestPaneHandle>(null);
  const onSend = useCallback(() => {
    // The debounced envelope edit may not have reached the store yet — flush it first so the
    // send picks up what's on screen, not a stale copy from up to DEBOUNCE_MS ago.
    requestPaneRef.current?.flush();
    void send(requestId);
  }, [send, requestId]);
  const onCancel = useCallback(() => {
    void cancel(requestId);
  }, [cancel, requestId]);
  const onEnvelopeChange = useCallback(
    (envelopeXml: string) => {
      updateRequest(requestId, { envelopeXml });
      // Last run's findings described text that no longer exists; keeping the markers around
      // would point at lines the user has already fixed (or moved).
      clearValidation(requestId, 'request');
    },
    [updateRequest, requestId],
  );
  const onValidate = useCallback(() => {
    requestPaneRef.current?.flush();
    void validateAndReport(requestId, 'request', useProjectStore.getState().requests[requestId]?.envelopeXml);
  }, [requestId]);
  const onEndpointChange = useCallback(
    (endpoint: string) => {
      setEndpoint(requestId, endpoint);
    },
    [setEndpoint, requestId],
  );

  const orientation = groupOrientation(layout);

  if (draft === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  return (
    <section
      aria-label={`Request ${draft.name}`}
      data-testid="request-editor"
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        // `request.cancel` is on the window dispatcher's editable-field allow-list, so Escape
        // already reaches it from inside the editor; this handler is what makes that work when
        // the dispatcher is not installed (the pane rendered on its own). It stops propagation
        // so the two can never both fire for one keystroke.
        if (event.key !== 'Escape' || !sending || !isTextInput(event.target)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <RequestToolbar
        draft={draft}
        summary={summary}
        endpoint={endpoint}
        endpointSource={endpointSource}
        trustInvalid={trustInvalid}
        sending={sending}
        onSend={onSend}
        onCancel={onCancel}
        onEndpointChange={onEndpointChange}
        sendShortcut={shortcutFor('request.send', platform)}
        onValidate={onValidate}
        validateShortcut={shortcutFor('request.validate', platform)}
      />

      {layout.mode === 'tabs' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ViewTabs
            label="Editor panes"
            items={PANE_TABS}
            active={pane}
            onSelect={(id) => setPane(id as typeof pane)}
          />
          <div className="min-h-0 flex-1">
            {pane === 'request' ? (
              <RequestContextMenu draft={draft}>
                <RequestPane
                  ref={requestPaneRef}
                  requestId={requestId}
                  envelopeXml={draft.envelopeXml}
                  onEnvelopeChange={onEnvelopeChange}
                  onSend={onSend}
                  interfaceId={draft.interfaceId}
                  bindingName={draft.bindingName}
                  operationName={draft.operationName}
                />
              </RequestContextMenu>
            ) : (
              <ResponsePane state={exchange} interfaceId={draft.interfaceId} requestId={requestId} />
            )}
          </div>
        </div>
      ) : (
        <Group
          orientation={orientation}
          className={`flex min-h-0 flex-1 ${orientation === 'horizontal' ? '' : 'flex-col'}`}
        >
          <Panel id="request-pane" defaultSize="50%" minSize="20%">
            <RequestContextMenu draft={draft}>
              <RequestPane
                ref={requestPaneRef}
                requestId={requestId}
                envelopeXml={draft.envelopeXml}
                onEnvelopeChange={onEnvelopeChange}
                onSend={onSend}
                interfaceId={draft.interfaceId}
                bindingName={draft.bindingName}
                operationName={draft.operationName}
              />
            </RequestContextMenu>
          </Panel>
          <Separator aria-label="Resize" className={`${SEPARATOR} ${orientation === 'horizontal' ? 'w-px' : 'h-px'}`} />
          <Panel id="response-pane" minSize="20%">
            <ResponsePane state={exchange} interfaceId={draft.interfaceId} requestId={requestId} />
          </Panel>
        </Group>
      )}

      <CloneRequestDialog
        open={dialog === 'clone'}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        requestId={requestId}
        requestName={draft.name}
      />
      <ImportCurlDialog
        open={dialog === 'import-curl'}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        operation={{
          interfaceId: draft.interfaceId,
          bindingName: draft.bindingName,
          operationName: draft.operationName,
        }}
      />
      <WssUsernameTokenDialog
        open={dialog === 'wss-username-token'}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        requestId={requestId}
      />
      <WsTimestampDialog
        open={dialog === 'wss-timestamp'}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        requestId={requestId}
      />
    </section>
  );
}
