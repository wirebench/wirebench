import { Button } from '../../components/button.js';
import {
  ACTION_GROUP_LABELS,
  actionLabel,
  actorLabel,
  targetLabel,
  type ActionGroup,
} from '../../state/audit-format.js';
import type { AuditEventWire } from '../../../shared/wire-types.js';

/** One audit event in full (audit-log spec §3.6): the same `<dl>` grid as the License tab, then the details object. */
export function AuditDetail({ event, onClose }: { readonly event: AuditEventWire; readonly onClose: () => void }) {
  const group = event.action.split('.')[0] ?? '';
  const groupLabel = ACTION_GROUP_LABELS[group as ActionGroup] ?? group;
  return (
    <section aria-label="Event detail" data-testid="audit-detail" className="flex flex-col gap-2 text-sm">
      <div className="flex justify-end">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
        <dt className="text-fg-subtle">When</dt>
        <dd>{new Date(event.at).toLocaleString()}</dd>
        <dt className="text-fg-subtle">Who</dt>
        <dd>{actorLabel(event.actor)}</dd>
        <dt className="text-fg-subtle">What</dt>
        <dd>
          {actionLabel(event.action)} ({groupLabel})
        </dd>
        <dt className="text-fg-subtle">Target</dt>
        <dd>{targetLabel(event)}</dd>
        <dt className="text-fg-subtle">Workspace</dt>
        <dd>{event.workspaceId ?? '—'}</dd>
        <dt className="text-fg-subtle">Team</dt>
        <dd>{event.teamId ?? '—'}</dd>
        <dt className="text-fg-subtle">Address</dt>
        <dd>{event.ip ?? '—'}</dd>
        <dt className="text-fg-subtle">Client</dt>
        <dd className="break-words">{event.userAgent ?? '—'}</dd>
        <dt className="text-fg-subtle">Event id</dt>
        <dd className="font-mono text-xs break-all">{event.id}</dd>
      </dl>
      <h3 className="text-xs text-fg-subtle">Details</h3>
      <pre
        data-testid="audit-details-json"
        className="overflow-x-auto rounded-sm bg-surface-hover p-2 font-mono text-xs"
      >
        {JSON.stringify(event.details, null, 2)}
      </pre>
    </section>
  );
}
