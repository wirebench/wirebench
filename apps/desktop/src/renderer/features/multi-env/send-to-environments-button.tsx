/**
 * *Send to environments…* next to Send in the SOAP and REST editors, with the picker it opens.
 * Cancel while the fan-out runs; disabled, with the reason on its title, when unavailable.
 */
import { Layers, Square } from 'lucide-react';
import { Button } from '../../components/button.js';
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

export interface SendToEnvironmentsButtonProps {
  readonly requestId: string;
  readonly kind: MultiEnvKind;
}

export function SendToEnvironmentsButton({ requestId, kind }: SendToEnvironmentsButtonProps) {
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
          onClick={() => void cancelSendToEnvironments(requestId)}
        >
          <Square size={12} aria-hidden="true" />
          Cancel
        </Button>
      ) : (
        <Button
          variant="secondary"
          data-testid="send-to-environments"
          aria-label="Compare environments…"
          title={blocker ?? 'Send to several environments and compare'}
          disabled={blocker !== undefined}
          onClick={() => openEnvPicker(requestId, kind)}
        >
          <Layers size={12} aria-hidden="true" />
          Environments…
        </Button>
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
