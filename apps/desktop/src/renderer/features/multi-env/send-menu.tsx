/**
 * The ▾ half of the split Send button in the SOAP and REST editors: a menu whose item *Send to
 * environments…* opens the picker. While that fan-out runs the ▾ becomes a stop button. The item is
 * disabled, with the reason on its title, when the request cannot be sent to several environments.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Layers, Square } from 'lucide-react';
import { Button, SPLIT_TAIL_CLASS } from '../../components/button.js';
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
              className="min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
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
