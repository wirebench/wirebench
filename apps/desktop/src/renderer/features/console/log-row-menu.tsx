import { Fragment } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { showToast } from '../../components/toast.js';
import { type LogEntry, useExchangesStore } from '../../state/exchanges.js';
import { ipc } from '../../state/ipc-client.js';
import { openGrpcRequestTab } from '../grpc-editor/grpc-actions.js';
import { openWsRequestTab } from '../ws-editor/ws-actions.js';
import { openRequestTab } from '../request-editor/request-actions.js';
import { openRestRequestTab } from '../rest-editor/rest-actions.js';
import { protocolOf, urlOf } from './log-filter.js';
import {
  headersText,
  projectLookup,
  requestHeadersOf,
  requestIdOf,
  responseBodyText,
  rowActions,
  type RowActionId,
} from './log-row-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted data-[disabled]:cursor-default data-[disabled]:text-fg-faint';

/** Where the actions split into groups: cURL · copy · the saved request. */
const GROUP_ENDS: ReadonlySet<RowActionId> = new Set(['curl-powershell', 'copy-response-body']);

async function copy(text: string, toast: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(toast);
  } catch {
    showToast('Could not copy to the clipboard');
  }
}

/** Carries out one row action. cURL comes from main; everything else is copied from what the row holds. */
export async function runRowAction(id: RowActionId, entry: LogEntry): Promise<void> {
  switch (id) {
    case 'curl-posix':
    case 'curl-powershell': {
      const shell = id === 'curl-posix' ? 'posix' : 'powershell';
      const result = await ipc().log.curl({ entry, shell });
      if (!result.ok) {
        showToast(result.error.message);
        return;
      }
      await copy(result.value.command, shell === 'powershell' ? 'Copied as cURL (PowerShell)' : 'Copied as cURL');
      if (result.value.notes !== undefined) {
        showToast(result.value.notes.join(' '));
      }
      return;
    }
    case 'copy-url':
      return copy(urlOf(entry), 'Copied URL');
    case 'copy-request-headers':
      return copy(headersText(requestHeadersOf(entry)), 'Copied request headers');
    case 'copy-response-headers':
      return entry.kind === 'exchange'
        ? copy(
            headersText('protocol' in entry.exchange ? entry.exchange.responseHeaders : entry.exchange.http.headers),
            'Copied response headers',
          )
        : undefined;
    case 'copy-response-body': {
      const body = responseBodyText(entry);
      return body === undefined ? undefined : copy(body, 'Copied response body');
    }
    case 'resend': {
      const requestId = requestIdOf(entry);
      const protocol = protocolOf(entry);
      // `log.resend` does not cover WebSocket yet (Task 10 of #98); nothing to do here until it does.
      if (requestId === undefined || protocol === 'websocket') {
        return;
      }
      const result = await ipc().log.resend({ protocol, requestId });
      if (result.ok) {
        useExchangesStore.getState().appendExchange(result.value.exchange, requestId);
      } else {
        showToast(result.error.message);
      }
      return;
    }
    case 'open-request': {
      const requestId = requestIdOf(entry);
      if (requestId === undefined) {
        return;
      }
      const protocol = protocolOf(entry);
      if (protocol === 'rest') {
        openRestRequestTab(requestId);
      } else if (protocol === 'grpc') {
        openGrpcRequestTab(requestId);
      } else if (protocol === 'websocket') {
        openWsRequestTab(requestId);
      } else {
        openRequestTab(requestId);
      }
      return;
    }
  }
}

export interface LogRowMenuProps {
  readonly entry: LogEntry;
  /** A pointer position (right-click) or the element the menu opens from (a row, the ⋯ button). */
  readonly anchor: { x: number; y: number } | HTMLElement;
  readonly onClose: () => void;
  /** Where focus goes once the menu closes; the log list, so the arrow keys keep working. */
  readonly returnFocus?: () => void;
}

function anchorBox(anchor: LogRowMenuProps['anchor']): { left: number; top: number; width: number; height: number } {
  if (anchor instanceof HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  return { left: anchor.x, top: anchor.y, width: 0, height: 0 };
}

/** The HTTP Log row menu: what {@link rowActions} offers for the row, opened at `anchor`. */
export function LogRowMenu({ entry, anchor, onClose, returnFocus }: LogRowMenuProps) {
  const actions = rowActions(entry, projectLookup());
  return (
    <DropdownMenu.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DropdownMenu.Trigger asChild>
        {/* An invisible box over the anchor: the menu positions itself against it. */}
        <span
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: 'fixed', pointerEvents: 'none', ...anchorBox(anchor) }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Row actions"
          side="bottom"
          align="start"
          sideOffset={2}
          className="min-w-56 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          onCloseAutoFocus={(event) => {
            if (returnFocus !== undefined) {
              event.preventDefault();
              returnFocus();
            }
          }}
        >
          {actions.map((action) => (
            <Fragment key={action.id}>
              <DropdownMenu.Item
                className={ITEM_CLASS}
                disabled={!action.enabled}
                title={action.enabled ? action.hint : action.reason}
                onSelect={() => {
                  void runRowAction(action.id, entry);
                }}
              >
                {action.label}
              </DropdownMenu.Item>
              {GROUP_ENDS.has(action.id) && <DropdownMenu.Separator className="my-1 h-px bg-hairline" />}
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
