/** The webhooks dialogs, mounted once in the shell: the confirmation for Rotate, Clear and Delete. */
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { webhooksActions } from './webhooks-actions.js';
import { useWebhooksDialogs, type WebhooksConfirm } from './webhooks-dialogs-state.js';

const COPY: Readonly<
  Record<WebhooksConfirm['action'], { readonly title: string; readonly description: string; readonly label: string }>
> = {
  rotate: {
    title: 'Rotate URL?',
    description:
      'The current URL stops working at once: anything still sending to it gets 404 until it has the new one.',
    label: 'Rotate',
  },
  clear: {
    title: 'Clear captures?',
    description: 'Deletes every capture of this catch URL on the server, for everyone in the workspace.',
    label: 'Clear',
  },
  delete: {
    title: 'Delete catch URL?',
    description: 'Deletes the catch URL and its captures for everyone in the workspace. Its URL stops working at once.',
    label: 'Delete',
  },
};

export function WebhooksDialogs() {
  const confirm = useWebhooksDialogs((state) => state.confirm);
  const closeConfirm = useWebhooksDialogs((state) => state.closeConfirm);
  const copy = confirm === undefined ? undefined : COPY[confirm.action];
  return (
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
  );
}
