/**
 * A schedule's secrets (#517, scheduled-runs spec §3.3): the values a run resolves where a pipeline would
 * set `WIREBENCH_SECRET_<NAME>`. Values are write-only: the dialog lists each name with its last four
 * characters, sets new values and clears old ones, and never shows a stored value.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { useSchedulesStore } from '../../state/schedules.js';
import { INPUT_CLASS } from '../team/roles.js';
import { useSchedulesDialogs } from './schedules-dialogs-state.js';

/** A secret's name as a pipeline sets it, without the `WIREBENCH_SECRET_` prefix (`SCHEDULE_SECRET_NAME_PATTERN`). */
const NAME_PATTERN = /^[A-Z0-9_]{1,128}$/;

export interface SecretRow {
  readonly name: string;
  readonly value: string;
}

/** The map the server takes: new and changed values, and `null` for each cleared name. */
export function secretsRequestOf(
  rows: readonly SecretRow[],
  cleared: readonly string[],
): Record<string, string | null> {
  return {
    ...Object.fromEntries(cleared.map((name) => [name, null])),
    ...Object.fromEntries(rows.filter((row) => row.value !== '').map((row) => [row.name.trim(), row.value])),
  };
}

/** The first thing the server would refuse; `undefined` when none. */
export function secretsProblemOf(rows: readonly SecretRow[]): string | undefined {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === '' && row.value === '') continue;
    if (!NAME_PATTERN.test(name)) return `"${name}" is not a secret name: use A–Z, 0–9 and _ only.`;
    if (row.value === '') return `Enter a value for ${name}.`;
    if (names.has(name)) return `${name} is listed twice.`;
    names.add(name);
  }
  return undefined;
}

export function ScheduleSecretsDialog() {
  const open = useSchedulesDialogs((state) => state.secrets);
  const close = useSchedulesDialogs((state) => state.closeSecrets);
  const schedule = useSchedulesStore((state) =>
    open === undefined ? undefined : state.schedules.find((candidate) => candidate.id === open.scheduleId),
  );
  const [rows, setRows] = useState<readonly SecretRow[]>([]);
  const [cleared, setCleared] = useState<readonly string[]>([]);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open === undefined) return;
    setRows([{ name: '', value: '' }]);
    setCleared([]);
    setRefused(undefined);
  }, [open]);

  const filled = rows.filter((row) => row.name.trim() !== '' || row.value !== '');
  const problem = secretsProblemOf(filled);
  const nothing = filled.length === 0 && cleared.length === 0;

  const save = async (): Promise<void> => {
    const server = useSchedulesStore.getState().server;
    if (server === undefined || open === undefined || problem !== undefined || nothing) return;
    setBusy(true);
    const result = await ipc().schedules.setSecrets({
      ...server,
      scheduleId: open.scheduleId,
      secrets: secretsRequestOf(filled, cleared),
    });
    setBusy(false);
    if (!result.ok) {
      setRefused(result.error.message);
      return;
    }
    close();
    await useSchedulesStore.getState().refresh();
  };

  const setRow = (index: number, patch: Partial<SecretRow>): void =>
    setRows(rows.map((current, at) => (at === index ? { ...current, ...patch } : current)));

  return (
    <Dialog.Root
      open={open !== undefined}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="schedule-secrets"
          className="fixed top-1/2 left-1/2 w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Secrets of {schedule?.name}</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            A run reads a secret where a pipeline would set WIREBENCH_SECRET_&lt;NAME&gt;. Values are sealed on the
            server and never shown again.
          </Dialog.Description>
          <ul className="mt-3 flex flex-col gap-1">
            {(schedule?.secrets ?? []).map((secret) => {
              const isCleared = cleared.includes(secret.name);
              return (
                <li key={secret.name} data-testid="schedule-secret" className="flex items-center gap-2 text-sm">
                  <code className={`min-w-0 flex-1 truncate ${isCleared ? 'text-fg-subtle line-through' : ''}`}>
                    {secret.name}
                  </code>
                  <span className="text-fg-subtle">{secret.hint === null ? 'set' : `…${secret.hint}`}</span>
                  <Button
                    data-testid="schedule-secret-clear"
                    onClick={() =>
                      setCleared(isCleared ? cleared.filter((name) => name !== secret.name) : [...cleared, secret.name])
                    }
                  >
                    {isCleared ? 'Keep' : 'Clear'}
                  </Button>
                </li>
              );
            })}
          </ul>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <ul className="mt-3 flex flex-col gap-2">
              {rows.map((row, index) => (
                <li key={index} className="flex items-center gap-2">
                  <input
                    aria-label={`Secret ${String(index + 1)} name`}
                    data-testid="schedule-secret-name"
                    placeholder="NAME"
                    value={row.name}
                    onChange={(event) => setRow(index, { name: event.target.value })}
                    className={`${INPUT_CLASS} w-48 font-mono`}
                  />
                  <input
                    type="password"
                    aria-label={`Secret ${String(index + 1)} value`}
                    data-testid="schedule-secret-value"
                    placeholder="Value"
                    value={row.value}
                    onChange={(event) => setRow(index, { value: event.target.value })}
                    className={`${INPUT_CLASS} min-w-0 flex-1`}
                  />
                  <button
                    type="button"
                    aria-label={`Remove secret ${String(index + 1)}`}
                    className="rounded p-1 text-fg-muted hover:bg-surface-hover"
                    onClick={() => setRows(rows.filter((_, at) => at !== index))}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <Button className="mt-2" onClick={() => setRows([...rows, { name: '', value: '' }])}>
              <Plus size={12} aria-hidden="true" className="mr-1 inline" />
              Add a secret
            </Button>
            {(refused ?? problem) !== undefined && (
              <p role="alert" data-testid="schedule-secrets-problem" className="mt-2 text-sm text-status-danger">
                {refused ?? problem}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button
                type="submit"
                data-testid="schedule-secrets-save"
                variant="primary"
                disabled={busy || problem !== undefined || nothing}
              >
                Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
