/** The webhooks dialogs, mounted once in the shell: the settings dialog, and the confirmation for Rotate, Clear and Delete. */
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { CatchUrlSettingsDialog } from './catch-url-settings-dialog.js';
import { webhooksActions } from './webhooks-actions.js';
import { useWebhooksDialogs, type WebhooksConfirm } from './webhooks-dialogs-state.js';

/** R-B10: Rotate's own sentence, and half of Delete's — both send the same "acts at once" warning. */
const STOPS_WORKING_AT_ONCE = 'Its URL stops working at once';

const COPY: Readonly<
  Record<WebhooksConfirm['action'], { readonly title: string; readonly description: string; readonly label: string }>
> = {
  rotate: {
    title: 'Rotate URL?',
    description: `${STOPS_WORKING_AT_ONCE}: anything still sending to the old one gets 404 until it has the new one.`,
    label: 'Rotate',
  },
  clear: {
    title: 'Clear captures?',
    description: 'Deletes every capture of this catch URL on the server, for everyone in the workspace.',
    label: 'Clear',
  },
  delete: {
    title: 'Delete catch URL?',
    description: `Deletes the catch URL and its captures for everyone in the workspace. ${STOPS_WORKING_AT_ONCE}.`,
    label: 'Delete',
  },
};

export function WebhooksDialogs() {
  const confirm = useWebhooksDialogs((state) => state.confirm);
  const closeConfirm = useWebhooksDialogs((state) => state.closeConfirm);
  const copy = confirm === undefined ? undefined : COPY[confirm.action];
  return (
    <>
      <ConfirmDialog
        open={confirm !== undefined}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
        title={copy?.title ?? ''}
        description={copy?.description ?? ''}
        confirmLabel={copy?.label ?? ''}
        destructive
        testId="webhooks-confirm"
        onConfirm={() => {
          if (confirm !== undefined) void webhooksActions.run(confirm.action, confirm.hookId);
        }}
      />
      <CatchUrlSettingsDialog />
    </>
  );
}
