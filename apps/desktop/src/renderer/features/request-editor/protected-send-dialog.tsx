import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { answerProtectedSend, useProtectedSendStore } from '../../state/protected-send.js';

/**
 * Asked before a browser tab's agent send under a protected environment (#345): the words the desktop's own
 * prompt uses. Cancel, Escape and a click outside all answer "do not send".
 */
export function ProtectedSendDialog() {
  const environment = useProtectedSendStore((state) => state.environment);
  return (
    <ConfirmDialog
      open={environment !== undefined}
      onOpenChange={(open) => {
        if (!open) answerProtectedSend(false);
      }}
      title={`Send to ${environment ?? ''}?`}
      description={`"${environment ?? ''}" is a protected environment. Check this is where you mean to send.`}
      confirmLabel="Send"
      onConfirm={() => {
        answerProtectedSend(true);
      }}
      testId="protected-send-dialog"
      confirmTestId="protected-send-confirm"
      cancelTestId="protected-send-cancel"
    />
  );
}
