/**
 * A schedule's dialog (#517): when it runs, what it runs, its options and its alerts. Create and edit
 * share it; only workspace admins reach it. What runs is picked from the open workspace: the project,
 * an environment, and the whole project, some of its APIs, folders and requests, or its sequences.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { useSchedulesStore } from '../../state/schedules.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { INPUT_CLASS, SELECT_CLASS } from '../team/roles.js';
import { openScheduleTab } from './schedules-actions.js';
import { useSchedulesDialogs } from './schedules-dialogs-state.js';
import {
  emptyAlertRow,
  formOf,
  problemOf,
  requestOf,
  withChoices,
  type AlertKind,
  type AlertRow,
  type ScheduleForm,
} from './schedule-form.js';
import type { ScheduleChoicesWire } from '@shared/schedules-wire.js';

const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';
const CHECK_CLASS = 'flex items-center gap-2 text-sm text-fg-default';
const NO_CHOICES: ScheduleChoicesWire = { items: [], sequences: [], environments: [] };
const ALERT_KINDS: readonly { readonly kind: AlertKind; readonly label: string }[] = [
  { kind: 'email', label: 'Email' },
  { kind: 'slack', label: 'Slack' },
  { kind: 'teams', label: 'Teams' },
  { kind: 'webhook', label: 'Webhook' },
];

/** This machine's time zone, the default for a new schedule. */
function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function timeZones(): readonly string[] {
  return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
}

function AlertRowFields({
  row,
  index,
  onChange,
  onRemove,
}: {
  readonly row: AlertRow;
  readonly index: number;
  readonly onChange: (row: AlertRow) => void;
  readonly onRemove: () => void;
}) {
  const label = ALERT_KINDS.find((entry) => entry.kind === row.kind)?.label ?? row.kind;
  return (
    <li data-testid="schedule-alert" className="flex items-start gap-2">
      <span className="mt-1.5 w-16 shrink-0 text-sm text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {row.kind === 'email' ? (
          <input
            aria-label={`Alert ${String(index + 1)} addresses`}
            data-testid="schedule-alert-to"
            placeholder="ops@example.com, oncall@example.com"
            value={row.to}
            onChange={(event) => onChange({ ...row, to: event.target.value })}
            className={`${INPUT_CLASS} w-full`}
          />
        ) : (
          <input
            aria-label={`Alert ${String(index + 1)} URL`}
            data-testid="schedule-alert-url"
            placeholder={row.was === undefined ? 'https://…' : `${row.was} (enter again to keep)`}
            value={row.url}
            onChange={(event) => onChange({ ...row, url: event.target.value })}
            className={`${INPUT_CLASS} w-full`}
          />
        )}
        {row.kind === 'webhook' && (
          <input
            type="password"
            aria-label={`Alert ${String(index + 1)} signing secret`}
            data-testid="schedule-alert-secret"
            placeholder="Signing secret (optional, 16 characters or more)"
            value={row.secret}
            onChange={(event) => onChange({ ...row, secret: event.target.value })}
            className={`${INPUT_CLASS} w-full`}
          />
        )}
      </div>
      <button
        type="button"
        aria-label={`Remove alert ${String(index + 1)}`}
        className="mt-1 rounded p-1 text-fg-muted hover:bg-surface-hover"
        onClick={onRemove}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

export function ScheduleDialog() {
  const edit = useSchedulesDialogs((state) => state.edit);
  const close = useSchedulesDialogs((state) => state.closeEdit);
  const projects = useWorkspaceStore((state) => state.workspace?.projects);
  const [form, setForm] = useState<ScheduleForm>(() => formOf(undefined, { timeZone: localTimeZone() }));
  const [choices, setChoices] = useState<ScheduleChoicesWire>(NO_CHOICES);
  const [choicesFor, setChoicesFor] = useState<string | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const scheduleId = edit?.scheduleId;
  // A linked project lives off the server, so a schedule cannot run it.
  const runnable = (projects ?? []).filter((project) => project.source === 'internal');

  // Filled once per opening: a list refresh while the dialog is open must not undo the user's typing.
  useEffect(() => {
    if (edit === undefined) return;
    const schedule =
      edit.scheduleId === undefined
        ? undefined
        : useSchedulesStore.getState().schedules.find((candidate) => candidate.id === edit.scheduleId);
    const only = useWorkspaceStore.getState().workspace?.projects.filter((project) => project.source === 'internal');
    setForm(
      formOf(schedule, {
        ...(edit.target !== undefined ? { target: edit.target } : {}),
        timeZone: localTimeZone(),
        ...(only?.length === 1 ? { projectId: only[0]!.id } : {}),
      }),
    );
    setChoices(NO_CHOICES);
    setChoicesFor(undefined);
    setRefused(undefined);
  }, [edit]);

  // The pickers follow the chosen project; the target's selectors are laid over them once known.
  const projectId = form.projectId;
  useEffect(() => {
    if (edit === undefined || projectId === '') return;
    let current = true;
    void ipc()
      .schedules.choices({ projectId })
      .then((result) => {
        if (!current) return;
        const next = result.ok ? result.value : NO_CHOICES;
        setChoices(next);
        setChoicesFor(projectId);
        setForm((existing) => withChoices(existing, next.items));
      });
    return () => {
      current = false;
    };
  }, [edit, projectId]);

  const problem = problemOf(form);
  const change = (patch: Partial<ScheduleForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setRefused(undefined);
  };
  const changeAlerts = (alerts: readonly AlertRow[]): void => change({ alerts, alertsTouched: true });
  const environment = choices.environments.find((candidate) => candidate.id === form.environment);

  const save = async (): Promise<void> => {
    const server = useSchedulesStore.getState().server;
    if (server === undefined || problem !== undefined) return;
    setBusy(true);
    const request = requestOf(form, choices.items);
    const result =
      scheduleId === undefined
        ? await ipc().schedules.create({ ...server, ...request })
        : await ipc().schedules.update({ ...server, scheduleId, ...request });
    setBusy(false);
    if (!result.ok) {
      setRefused(result.error.message);
      return;
    }
    close();
    await useSchedulesStore.getState().refresh();
    if (scheduleId === undefined) openScheduleTab(result.value.schedule.id);
  };

  const togglePick = (id: string, on: boolean): void =>
    change({ picked: on ? [...form.picked, id] : form.picked.filter((candidate) => candidate !== id) });
  const toggleSequence = (name: string, on: boolean): void =>
    change({ sequences: on ? [...form.sequences, name] : form.sequences.filter((candidate) => candidate !== name) });

  const shownProblem = refused ?? (form.name === '' ? undefined : problem);
  return (
    <Dialog.Root
      open={edit !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="schedule-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[90vh] w-[36rem] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">
            {scheduleId === undefined ? 'New schedule' : 'Edit schedule'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            The server runs it against the workspace&apos;s latest pushed version, whether or not anyone has the app
            open.
          </Dialog.Description>
          <form
            className="min-h-0 overflow-auto pr-1"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className={LABEL_CLASS} htmlFor="schedule-name">
              Name
            </label>
            <input
              id="schedule-name"
              data-testid="schedule-name"
              autoFocus
              value={form.name}
              onChange={(event) => change({ name: event.target.value })}
              className={`${INPUT_CLASS} w-full`}
            />
            <div className="flex gap-3">
              <div className="min-w-0 flex-1">
                <label className={LABEL_CLASS} htmlFor="schedule-when">
                  When (cron, @hourly, @daily, @weekly, every 5m)
                </label>
                <input
                  id="schedule-when"
                  data-testid="schedule-when"
                  placeholder="*/5 * * * *"
                  value={form.schedule}
                  onChange={(event) => change({ schedule: event.target.value })}
                  className={`${INPUT_CLASS} w-full font-mono`}
                />
              </div>
              <div className="w-48">
                <label className={LABEL_CLASS} htmlFor="schedule-zone">
                  Time zone
                </label>
                <input
                  id="schedule-zone"
                  data-testid="schedule-zone"
                  list="schedule-zones"
                  value={form.timeZone}
                  onChange={(event) => change({ timeZone: event.target.value })}
                  className={`${INPUT_CLASS} w-full`}
                />
                <datalist id="schedule-zones">
                  {timeZones().map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="min-w-0 flex-1">
                <label className={LABEL_CLASS} htmlFor="schedule-project">
                  Project
                </label>
                <select
                  id="schedule-project"
                  data-testid="schedule-project"
                  value={form.projectId}
                  onChange={(event) =>
                    change({
                      projectId: event.target.value,
                      environment: '',
                      picked: [],
                      extraSelectors: [],
                      sequences: [],
                    })
                  }
                  className={`${SELECT_CLASS} w-full`}
                >
                  <option value="">Choose…</option>
                  {runnable.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-0 flex-1">
                <label className={LABEL_CLASS} htmlFor="schedule-environment">
                  Environment
                </label>
                <select
                  id="schedule-environment"
                  data-testid="schedule-environment"
                  value={form.environment}
                  onChange={(event) => change({ environment: event.target.value })}
                  className={`${SELECT_CLASS} w-full`}
                >
                  <option value="">None</option>
                  {choices.environments.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.protected === true ? `${candidate.name} (protected)` : candidate.name}
                    </option>
                  ))}
                  {form.environment !== '' && environment === undefined && choicesFor === projectId && (
                    <option value={form.environment}>{form.environment}</option>
                  )}
                </select>
              </div>
            </div>
            <fieldset className="mt-3">
              <legend className="text-sm text-fg-subtle">What runs</legend>
              <div className="mt-1 flex gap-4">
                {(
                  [
                    ['all', 'The whole project'],
                    ['pick', 'APIs, folders and requests'],
                    ['sequences', 'Sequences'],
                  ] as const
                ).map(([mode, label]) => (
                  <label key={mode} className={CHECK_CLASS}>
                    <input
                      type="radio"
                      name="schedule-mode"
                      data-testid={`schedule-mode-${mode}`}
                      checked={form.mode === mode}
                      onChange={() => change({ mode })}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {form.mode === 'pick' && (
                <ul
                  data-testid="schedule-picks"
                  className="mt-2 max-h-48 overflow-auto rounded border border-hairline p-1"
                >
                  {choices.items.length === 0 && (
                    <li className="p-1 text-sm text-fg-subtle">
                      {form.projectId === '' ? 'Choose a project first.' : 'This project has nothing a run can send.'}
                    </li>
                  )}
                  {choices.items.map((choice) => (
                    <li key={choice.id} style={{ paddingLeft: choice.depth * 16 }}>
                      <label className={CHECK_CLASS}>
                        <input
                          type="checkbox"
                          data-testid="schedule-pick"
                          checked={form.picked.includes(choice.id)}
                          onChange={(event) => togglePick(choice.id, event.target.checked)}
                        />
                        <span className={choice.kind === 'request' ? '' : 'font-medium'}>{choice.label}</span>
                      </label>
                    </li>
                  ))}
                  {form.extraSelectors.map((selector) => (
                    <li key={selector} className="flex items-center gap-2 text-sm text-fg-muted">
                      <code className="min-w-0 truncate">{selector}</code>
                      <button
                        type="button"
                        aria-label={`Remove ${selector}`}
                        className="rounded p-0.5 hover:bg-surface-hover"
                        onClick={() =>
                          change({ extraSelectors: form.extraSelectors.filter((candidate) => candidate !== selector) })
                        }
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {form.mode === 'sequences' && (
                <ul
                  data-testid="schedule-sequences"
                  className="mt-2 max-h-40 overflow-auto rounded border border-hairline p-1"
                >
                  {choices.sequences.length === 0 && (
                    <li className="p-1 text-sm text-fg-subtle">This project has no sequences.</li>
                  )}
                  {choices.sequences.map((name) => (
                    <li key={name}>
                      <label className={CHECK_CLASS}>
                        <input
                          type="checkbox"
                          data-testid="schedule-sequence"
                          checked={form.sequences.includes(name)}
                          onChange={(event) => toggleSequence(name, event.target.checked)}
                        />
                        {name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
            <fieldset className="mt-3 flex flex-col gap-1.5">
              <legend className="text-sm text-fg-subtle">Options</legend>
              <label className={CHECK_CLASS}>
                Timeout
                <input
                  aria-label="Timeout in minutes"
                  data-testid="schedule-timeout"
                  inputMode="numeric"
                  value={form.timeoutMinutes}
                  onChange={(event) => change({ timeoutMinutes: event.target.value })}
                  className={`${INPUT_CLASS} w-16`}
                />
                minutes
              </label>
              <label className={CHECK_CLASS}>
                <input
                  type="checkbox"
                  checked={form.bail}
                  onChange={(event) => change({ bail: event.target.checked })}
                />
                Stop at the first failure
              </label>
              <label className={CHECK_CLASS}>
                <input
                  type="checkbox"
                  data-testid="schedule-allow-protected"
                  checked={form.allowProtected}
                  onChange={(event) => change({ allowProtected: event.target.checked })}
                />
                Allow a protected environment (recorded in the audit log)
              </label>
              <label className={CHECK_CLASS}>
                <input
                  type="checkbox"
                  checked={form.insecureTls}
                  onChange={(event) => change({ insecureTls: event.target.checked })}
                />
                Skip TLS certificate checks (recorded in the audit log)
              </label>
              <label className={CHECK_CLASS}>
                <input
                  type="checkbox"
                  data-testid="schedule-enabled"
                  checked={form.enabled}
                  onChange={(event) => change({ enabled: event.target.checked })}
                />
                Enabled
              </label>
            </fieldset>
            <fieldset className="mt-3">
              <legend className="text-sm text-fg-subtle">Alerts</legend>
              <p className="text-xs text-fg-subtle">
                Sent when the schedule starts failing, and once more when it recovers. URLs are kept sealed on the
                server and only their host can be read back.
              </p>
              <ul className="mt-2 flex flex-col gap-2">
                {form.alerts.map((row, index) => (
                  <AlertRowFields
                    key={index}
                    row={row}
                    index={index}
                    onChange={(next) => changeAlerts(form.alerts.map((current, at) => (at === index ? next : current)))}
                    onRemove={() => changeAlerts(form.alerts.filter((_, at) => at !== index))}
                  />
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {ALERT_KINDS.map((entry) => (
                  <Button
                    key={entry.kind}
                    data-testid={`schedule-add-alert-${entry.kind}`}
                    onClick={() => changeAlerts([...form.alerts, emptyAlertRow(entry.kind)])}
                  >
                    <Plus size={12} aria-hidden="true" className="mr-1 inline" />
                    {entry.label}
                  </Button>
                ))}
                <label className={`${CHECK_CLASS} ml-auto`}>
                  Mute after
                  <input
                    aria-label="Mute after this many failing runs"
                    inputMode="numeric"
                    value={form.muteAfter}
                    onChange={(event) => change({ muteAfter: event.target.value, alertsTouched: true })}
                    className={`${INPUT_CLASS} w-14`}
                  />
                  failing runs
                </label>
              </div>
            </fieldset>
            {shownProblem !== undefined && (
              <p role="alert" data-testid="schedule-problem" className="mt-2 text-sm text-status-danger">
                {shownProblem}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button
                type="submit"
                data-testid="schedule-save"
                variant="primary"
                disabled={busy || problem !== undefined}
              >
                {scheduleId === undefined ? 'Create' : 'Save'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
