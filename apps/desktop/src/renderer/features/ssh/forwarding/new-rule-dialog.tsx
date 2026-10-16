import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import { findHost, upsertHost, useHostsStore } from '../hosts-store.js';
import { INPUT_CLASS } from '../inherited-field.js';
import { ForwardForm, forwardProblem, type ForwardFullEntry } from './forward-form.js';
import { moveRule } from './forward-groups.js';
import { freeRuleId } from './forwards-section.js';

const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 flex max-h-[85vh] w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-md bg-surface-raised p-4 shadow-lg';

const blank = (id: string): ForwardFullEntry => ({ id, type: 'local', port: Number.NaN });

/**
 * The Port forwarding view's New rule…: pick a host, fill in the rule as the host form does, and it is added
 * to that host's own rules in `hosts.yaml`. A rule for a whole group is still set in the group's settings.
 */
export function NewRuleDialog({
  open,
  groupId: openedFrom,
  onOpenChange,
}: {
  readonly open: boolean;
  /** The forwarding group it was opened from: its Forwarding group select starts there (#594). */
  readonly groupId?: string;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const resolved = useHostsStore((s) => s.resolved);
  const forwardGroups = useHostsStore((s) => s.file.forwardGroups) ?? [];
  const [groupId, setGroupId] = useState('');
  const groupPickerId = useId();
  const [hostId, setHostId] = useState('');
  const [entry, setEntry] = useState<ForwardFullEntry>(blank('forward'));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pickerId = useId();

  // The ids a host already resolves to, its own and its groups': a new rule takes none of them.
  const takenOn = (id: string): Set<string> =>
    new Set(resolved.find((host) => host.id === id)?.forwards.map((forward) => forward.rule.id) ?? []);

  useEffect(() => {
    if (!open) return;
    const first = useHostsStore.getState().resolved[0]?.id ?? '';
    setHostId(first);
    setEntry(blank(freeRuleId(takenOn(first))));
    setGroupId(openedFrom ?? '');
    setError(undefined);
    // Only on opening: the form keeps what is typed while hosts.yaml changes underneath.
  }, [open]);

  const problem = forwardProblem(entry);
  const taken = takenOn(hostId).has(entry.id);

  const submit = async (): Promise<void> => {
    const { file, save } = useHostsStore.getState();
    const host = findHost(file, hostId);
    if (host === undefined) {
      setError('That host is no longer in hosts.yaml');
      return;
    }
    setBusy(true);
    try {
      const added = upsertHost(file, { ...host, forwards: [...(host.forwards ?? []), entry] });
      // The rule and its group membership go in one save.
      const grouped = groupId === '' ? added : moveRule(added, hostId, entry.id, groupId);
      if (await save(grouped)) {
        onOpenChange(false);
        const group = forwardGroups.find((g) => g.id === groupId);
        showToast(`Rule ${entry.id} added to ${host.name}${group === undefined ? '' : `, in group ${group.name}`}`);
      } else {
        setError(useHostsStore.getState().problems[0]?.message ?? 'The rule could not be saved');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className={CONTENT_CLASS} data-testid="new-rule-dialog">
          <Dialog.Title className="text-md font-medium text-fg-default">New forwarding rule</Dialog.Title>
          <Dialog.Description className="text-sm text-fg-subtle">
            Added to the host&apos;s own rules. A rule for a whole group is set in the group&apos;s settings.
          </Dialog.Description>
          {resolved.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-fg-muted">A rule runs through a host. Add a host first.</p>
              <Button
                variant="primary"
                onClick={() => {
                  onOpenChange(false);
                  useHostsStore.getState().openDialog({ mode: 'new-host' });
                }}
              >
                New host…
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (problem !== undefined || taken || busy) return;
                void submit();
              }}
            >
              <label htmlFor={pickerId} className="flex flex-col gap-1 text-xs text-fg-subtle">
                Host
                <select
                  id={pickerId}
                  className={INPUT_CLASS}
                  value={hostId}
                  onChange={(event) => {
                    const next = event.target.value;
                    // A suggested id follows the host; one typed by hand stays.
                    if (entry.id === freeRuleId(takenOn(hostId))) {
                      setEntry({ ...entry, id: freeRuleId(takenOn(next)) });
                    }
                    setHostId(next);
                    setError(undefined);
                  }}
                >
                  {resolved.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.name}
                    </option>
                  ))}
                </select>
              </label>
              {forwardGroups.length > 0 && (
                <label htmlFor={groupPickerId} className="flex flex-col gap-1 text-xs text-fg-subtle">
                  Forwarding group
                  <select
                    id={groupPickerId}
                    className={INPUT_CLASS}
                    value={groupId}
                    onChange={(event) => {
                      setGroupId(event.target.value);
                    }}
                  >
                    <option value="">None</option>
                    {forwardGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <ForwardForm
                heading="Rule"
                entry={entry}
                onChange={(next) => {
                  setEntry(next);
                  setError(undefined);
                }}
              />
              {taken && <p className="text-xs text-status-warning">{`This host already has a rule ${entry.id}`}</p>}
              {error !== undefined && (
                <p role="alert" className="text-sm text-status-danger">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  onClick={() => {
                    onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={problem !== undefined || taken || busy}>
                  Add rule
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
