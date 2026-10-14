import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useSecretsVisibilityStore } from '../../state/secrets-visibility.js';

/**
 * Asked before the HTTP log shows real credentials. A confirmation rather than a reveal that turns
 * itself off after a timeout: someone reading a header would lose it mid-read, and the flag is
 * session-only anyway, so one deliberate yes is the cheaper guard. Hiding again never asks.
 */
export function RevealSecretsDialog() {
  const open = useSecretsVisibilityStore((state) => state.confirmingReveal);
  const answerReveal = useSecretsVisibilityStore((state) => state.answerReveal);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          void answerReveal(false);
        }
      }}
      title="Reveal secrets in the HTTP log?"
      description="Authorization headers, cookies and passwords will show in plain text until you hide them again or quit. Anyone who can see the screen, or a screenshot of it, can read them."
      confirmLabel="Reveal"
      destructive
      onConfirm={() => {
        void answerReveal(true);
      }}
      testId="reveal-secrets-dialog"
      confirmTestId="reveal-secrets-confirm"
    />
  );
}
