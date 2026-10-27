/**
 * The ▾ half of the split Send button in the SOAP and REST editors: a menu whose item *Send to
 * environments…* opens the picker. While that fan-out runs the ▾ becomes a stop button. The item is
 * disabled, with the reason on its title, when the request cannot be sent to several environments.
 *
 * Under it sit the two ways to take the request elsewhere instead of sending it — *Copy as cURL* and
 * *Generate code…* — each running the action its palette command and the Code panel already run, so
 * the menu never hands out a different command for the same request.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Code, Layers, Square, Terminal } from 'lucide-react';
import { Button, SPLIT_TAIL_CLASS } from '../../components/button.js';
import { useUiStore } from '../../state/ui.js';
import { copyAsCurl } from '../request-editor/request-actions.js';
import type { RequestCurlRequest } from '@shared/wire-types.js';
import { EnvPickerDialog } from './env-picker-dialog.js';
import {
  cancelSendToEnvironments,
  closeEnvPicker,
  openEnvPicker,
  sendToEnvironments,
  useMultiEnvState,
  useMultiEnvStore,
  type MultiEnvKind,
} from './multi-env-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';

/**
 * The shell each kind's *Copy as cURL* writes for, as its palette command does: a SOAP request's is
 * the POSIX one (PowerShell has a command of its own), a REST request's the one the Code panel shows.
 */
const CURL_SHELL: Readonly<Record<MultiEnvKind, () => RequestCurlRequest['shell']>> = {
  soap: () => 'posix',
  rest: () => useUiStore.getState().slideOver.codeShell,
};

export interface SendMenuProps {
  readonly requestId: string;
  readonly kind: MultiEnvKind;
}

export function SendMenu({ requestId, kind }: SendMenuProps) {
  const { environments, activeId, blocker } = useMultiEnvState(requestId);
  const open = useMultiEnvStore((state) => state.picker?.requestId === requestId);
  const remembered = useMultiEnvStore((state) => state.remembered[requestId]);
  const running = useMultiEnvStore((state) => state.running[requestId] !== undefined);

  return (
    <>
      {running ? (
        <Button
          variant="secondary"
          data-testid="send-to-environments-cancel"
          aria-label="Stop comparing environments"
          title="Stop comparing environments"
          className={SPLIT_TAIL_CLASS}
          onClick={() => void cancelSendToEnvironments(requestId)}
        >
          <Square size={12} aria-hidden="true" />
        </Button>
      ) : (
        // Not modal: the item opens a dialog, and a modal menu would leave the page inert behind it.
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <Button
              variant="primary"
              data-testid="send-menu"
              aria-label="More send options"
              title="More send options"
              className={SPLIT_TAIL_CLASS}
            >
              <ChevronDown size={12} aria-hidden="true" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={4}
              className="z-dropdown min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
            >
              <DropdownMenu.Item
                className={ITEM_CLASS}
                data-testid="send-to-environments"
                title={blocker ?? 'Send to several environments and compare'}
                disabled={blocker !== undefined}
                onSelect={() => openEnvPicker(requestId, kind)}
              >
                <Layers size={12} aria-hidden="true" />
                Send to environments…
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
              <DropdownMenu.Item
                className={ITEM_CLASS}
                data-testid="send-menu-copy-curl"
                onSelect={() => void copyAsCurl(requestId, CURL_SHELL[kind]())}
              >
                <Terminal size={12} aria-hidden="true" />
                Copy as cURL
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={ITEM_CLASS}
                data-testid="send-menu-generate-code"
                title="Open the Code panel for this request"
                onSelect={() => {
                  useUiStore.getState().openCode();
                }}
              >
                <Code size={12} aria-hidden="true" />
                Generate code…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      {open && (
        <EnvPickerDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              closeEnvPicker();
            }
          }}
          environments={environments}
          activeId={activeId}
          remembered={remembered}
          onSend={(selection) => {
            closeEnvPicker();
            void sendToEnvironments(requestId, kind, selection);
          }}
        />
      )}
    </>
  );
}
