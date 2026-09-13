/**
 * The request pane's right-click menu, kept short on purpose. Actions with a home elsewhere stay
 * out of it: Validate request is a toolbar button, Show code is the right rail's Code panel, and
 * Recreate, Create Empty Envelope, Clone and Copy as cURL are in the explorer's request menu and
 * the command palette. Monaco's own context menu is disabled for the request editor
 * (`contextMenu={false}` in `request-pane.tsx`) so this one reaches the user wherever they click
 * inside the pane.
 */

import type { ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { getActiveRequestEditor, getActiveRequestPaneHandle } from '../../editor/active-request-editor.js';
import { gotoLine } from '../../editor/xml-language.js';
import type { RequestDraft } from '../../state/project.js';
import { openRequestDialog } from './request-dialogs.js';
import { addWsaHeadersToEditor, removeWsaHeadersFromEditor } from './wsa-actions.js';
import { applyOutgoingWssToEditor, removeOutgoingWssFromEditor } from './wss-actions.js';
import { goToSchemaDefinitionAtCursor } from './schema-navigation.js';
import { validateAndReport } from './validate-actions.js';
import { checkWsiForRequest, lastSendId } from './wsi-actions.js';
import { useExchangesStore } from '../../state/exchanges.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

const SEPARATOR_CLASS = 'my-1 h-px bg-hairline';

export interface RequestContextMenuProps {
  readonly draft: RequestDraft;
  readonly children: ReactNode;
}

/** Formats the request editor's buffer through the pane handle, which owns the commit. */
function format(): void {
  getActiveRequestPaneHandle()?.formatAndCommit();
}

/** Opens Monaco's Go to line widget on whichever request editor is mounted. */
function goToLine(): void {
  const editor = getActiveRequestEditor();
  if (editor !== undefined) {
    gotoLine(editor);
  }
}

/** The last response's envelope for `requestId`, or `undefined` when nothing has been received. */
function responseEnvelopeXml(requestId: string): string | undefined {
  return useExchangesStore.getState().byRequest[requestId]?.exchange?.response?.envelopeXml;
}

export function RequestContextMenu({ draft, children }: RequestContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="flex h-full min-h-0 flex-col">{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-56 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
          <ContextMenu.Item
            className={ITEM_CLASS}
            disabled={responseEnvelopeXml(draft.id) === undefined}
            onSelect={() => {
              const envelopeXml = responseEnvelopeXml(draft.id);
              if (envelopeXml !== undefined) {
                void validateAndReport(draft.id, 'response', envelopeXml);
              }
            }}
          >
            Validate response
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            disabled={lastSendId(draft.id) === undefined}
            onSelect={() => {
              void checkWsiForRequest(draft.id);
            }}
          >
            Check WS-I compliance
          </ContextMenu.Item>
          <ContextMenu.Separator className={SEPARATOR_CLASS} />
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              goToSchemaDefinitionAtCursor();
            }}
          >
            Go to Schema Definition
          </ContextMenu.Item>
          <ContextMenu.Separator className={SEPARATOR_CLASS} />
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              openRequestDialog('import-curl', draft.id);
            }}
          >
            Import cURL…
          </ContextMenu.Item>

          <ContextMenu.Separator className={SEPARATOR_CLASS} />
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              openRequestDialog('wss-username-token', draft.id);
            }}
          >
            Add WSS Username Token…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              openRequestDialog('wss-timestamp', draft.id);
            }}
          >
            Add WS-Timestamp…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void applyOutgoingWssToEditor(draft.id);
            }}
          >
            Outgoing WSS → Apply to editor
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void removeOutgoingWssFromEditor(draft.id);
            }}
          >
            Outgoing WSS → Remove
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void addWsaHeadersToEditor(draft.id);
            }}
          >
            WS-A Headers → Add to editor
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void removeWsaHeadersFromEditor(draft.id);
            }}
          >
            WS-A Headers → Remove
          </ContextMenu.Item>

          <ContextMenu.Separator className={SEPARATOR_CLASS} />
          <ContextMenu.Item className={ITEM_CLASS} onSelect={format}>
            Format
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={goToLine}>
            Go to line…
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
