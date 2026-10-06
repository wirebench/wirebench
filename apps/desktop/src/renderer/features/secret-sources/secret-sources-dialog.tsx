import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore } from '../../state/ui.js';
import type {
  SecretSourceEntryWire,
  SecretSourcesSetResponse,
  SecretSourcesState,
} from '../../../shared/wire-types.js';
import { openSecretSourcesApproval } from './actions.js';
import { KIND_FIELDS } from './kind-fields.js';
import { EntryLocation, entryProblem, kindLabel } from './location.js';

type Scope = 'shared' | 'local';

const INPUT_CLASS =
  'rounded border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent aria-[invalid=true]:border-status-danger';

type Issue = SecretSourcesSetResponse['issues'][number];

/** The add / edit form's state. `editing` is the entry being changed, when it is not a new one. */
interface FormState {
  readonly editing: { readonly name: string; readonly scope: Scope } | undefined;
  readonly name: string;
  readonly scope: Scope;
  readonly kind: string;
  readonly values: Readonly<Record<string, string>>;
}

type TestResult = { readonly ok: true; readonly length: number } | { readonly ok: false; readonly message: string };

const rowKey = (entry: SecretSourceEntryWire): string => `${entry.origin}:${entry.name}`;

/**
 * *Secret Sources…*: the workspace's `${secret:name}` → secret-manager map. Shared entries live in
 * `workspace.yaml` and need approval on each machine; This machine's live in `local.yaml` and win.
 *
 * Writes are one entry at a time, and main validates them (the renderer loads no zod schemas), so an
 * entry this form cannot represent, an invalid one, is shown with its reason and never sent back
 * edited. Only locators cross the bridge; `Test` answers a length, never a value.
 */
export function SecretSourcesDialog() {
  const target = useUiStore((state) => state.secretSourcesDialog);
  const setTarget = useUiStore((state) => state.setSecretSourcesDialog);
  const approvalOpen = useUiStore((state) => state.secretSourcesApproval);
  const open = target !== null;

  const [state, setState] = useState<SecretSourcesState | undefined>(undefined);
  const [form, setForm] = useState<FormState | undefined>(undefined);
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<Readonly<Record<string, TestResult>>>({});
  const [saving, setSaving] = useState(false);
  const live = useRef(false);
  const baseId = useId();

  const load = async (): Promise<void> => {
    const result = await ipc().secretSources.get(undefined);
    if (!live.current) {
      return;
    }
    if (result.ok) {
      setState(result.value);
    } else {
      setError(result.error.message);
    }
  };

  const blankForm = (name: string): FormState => ({
    editing: undefined,
    name,
    scope: 'shared',
    kind: 'vault',
    values: {},
  });

  useEffect(() => {
    live.current = open;
    setState(undefined);
    setIssues([]);
    setError(undefined);
    setResults({});
    setForm(target?.name === undefined ? undefined : blankForm(target.name));
    if (open) {
      void load();
    }
    return () => {
      live.current = false;
    };
  }, [open, target?.name]);

  // A teammate's change pulled in while the dialog is open, or a switch of workspace, changes the
  // mapping and what is trusted; read it again so the list and the banner do not go stale.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    return window.wirebench.on('workspace.changed', () => {
      void load();
    });
  }, [open]);

  // The approval dialog changes what is trusted; read it again when that dialog closes.
  const approvalWasOpen = useRef(false);
  useEffect(() => {
    if (open && approvalWasOpen.current && !approvalOpen) {
      void load();
    }
    approvalWasOpen.current = approvalOpen;
  }, [approvalOpen]);

  const send = async (
    scope: Scope,
    request: { name: string; previousName?: string; entry: Record<string, string> | null; create?: boolean },
  ): Promise<readonly Issue[] | undefined> => {
    const channel = scope === 'shared' ? ipc().secretSources.setShared : ipc().secretSources.setLocal;
    const result = await channel(request);
    if (!live.current) {
      return undefined;
    }
    if (!result.ok) {
      setError(result.error.message);
      return undefined;
    }
    if (!result.value.ok) {
      return result.value.issues;
    }
    setError(undefined);
    // What a Test said about an entry is stale once that entry is written.
    setResults((current) => {
      const next = { ...current };
      delete next[`${scope}:${request.name}`];
      if (request.previousName !== undefined) {
        delete next[`${scope}:${request.previousName}`];
      }
      return next;
    });
    await load();
    return [];
  };

  const save = async (): Promise<void> => {
    if (form === undefined || saving) {
      return;
    }
    if (KIND_FIELDS[form.kind] === undefined) {
      setIssues([{ name: form.name, reason: `unknown kind "${form.kind}"; nothing was saved` }]);
      return;
    }
    const creating = form.editing === undefined;
    if (creating && state?.entries.some((entry) => entry.origin === form.scope && entry.name === form.name) === true) {
      setIssues([{ name: form.name, reason: `"${form.name}" is already mapped here; edit or remove it instead` }]);
      return;
    }
    const entry: Record<string, string> = { kind: form.kind };
    for (const [key, value] of Object.entries(form.values)) {
      if (
        value.length > 0 &&
        (KIND_FIELDS[form.kind]?.required.includes(key) || KIND_FIELDS[form.kind]?.optional.includes(key))
      ) {
        entry[key] = value;
      }
    }
    const renamed = form.editing !== undefined && form.editing.name !== form.name;
    setSaving(true);
    setIssues([]);
    const sent = await send(form.scope, {
      name: form.name,
      ...(renamed && form.editing !== undefined ? { previousName: form.editing.name } : {}),
      entry,
      ...(creating ? { create: true } : {}),
    });
    setSaving(false);
    if (sent === undefined) {
      return;
    }
    if (sent.length > 0) {
      setIssues(sent);
      return;
    }
    setForm(undefined);
  };

  const remove = async (entry: SecretSourceEntryWire): Promise<void> => {
    const sent = await send(entry.origin, { name: entry.name, entry: null });
    if (sent !== undefined && sent.length > 0) {
      setError(sent.map((issue) => issue.reason).join(' '));
    }
  };

  const testEntry = async (entry: SecretSourceEntryWire): Promise<void> => {
    const key = rowKey(entry);
    const result = await ipc().secretSources.test({ name: entry.name });
    if (!live.current) {
      return;
    }
    setResults((current) => ({
      ...current,
      [key]: result.ok
        ? result.value.ok
          ? { ok: true, length: result.value.length }
          : { ok: false, message: result.value.message }
        : { ok: false, message: result.error.message },
    }));
  };

  const edit = (entry: SecretSourceEntryWire): void => {
    setIssues([]);
    setResults((current) => {
      const next = { ...current };
      delete next[rowKey(entry)];
      return next;
    });
    setForm({
      editing: { name: entry.name, scope: entry.origin },
      name: entry.name,
      scope: entry.origin,
      kind: entry.kind,
      values: entry.fields,
    });
  };

  const patch = (change: Partial<FormState>): void => {
    setForm((current) => (current === undefined ? current : { ...current, ...change }));
  };

  const topIssues = issues.filter((issue) => issue.field === undefined || !fieldsOf(form?.kind).includes(issue.field));
  const kinds = Object.keys(KIND_FIELDS).filter((kind) => kind !== 'none' || form?.scope === 'local');

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTarget(null);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="secret-sources-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[44rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
          onEscapeKeyDown={(event) => {
            if (form !== undefined) {
              event.preventDefault();
              setForm(undefined);
            }
          }}
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Secret Sources</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            Map a <code className="font-mono">{'${secret:name}'}</code> to a secret manager. Shared entries are saved in
            the workspace; This machine entries stay here and win. A value is never stored or shown.
          </Dialog.Description>

          {state?.problem !== undefined && (
            <p role="alert" className="mt-2 rounded border border-status-danger px-2 py-1 text-sm text-status-danger">
              {state.problem}
            </p>
          )}
          {state !== undefined && state.open && !state.trusted && (
            <div className="mt-2 flex items-center gap-2 rounded border border-hairline-strong px-2 py-1 text-sm text-fg-default">
              <span className="min-w-0 flex-1">
                This workspace&apos;s shared secret sources are not approved on this machine.
              </span>
              <Button variant="ghost" onClick={() => openSecretSourcesApproval()}>
                Review and approve…
              </Button>
            </div>
          )}

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {state === undefined ? (
              error === undefined && <p className="text-sm text-fg-subtle">Loading…</p>
            ) : !state.open ? (
              <p className="text-sm text-fg-subtle">Open a workspace to map secrets to a secret manager.</p>
            ) : state.entries.length === 0 ? (
              <p className="text-sm text-fg-subtle">No secret is mapped to a secret manager.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-fg-subtle">
                  <tr>
                    <th className="py-1 pr-2 font-normal">Name</th>
                    <th className="py-1 pr-2 font-normal">Kind</th>
                    <th className="py-1 pr-2 font-normal">Location</th>
                    <th className="py-1 pr-2 font-normal">Scope</th>
                    <th className="py-1 font-normal">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.entries.map((entry) => {
                    const result = results[rowKey(entry)];
                    const invalid = entryProblem(entry) !== undefined;
                    return (
                      <tr
                        key={rowKey(entry)}
                        aria-label={`Secret source ${entry.name}`}
                        className="border-t border-hairline align-top"
                      >
                        <td className="py-1.5 pr-2 font-mono">{entry.name}</td>
                        <td className={`py-1.5 pr-2 ${invalid ? 'text-status-danger' : ''}`}>{kindLabel(entry)}</td>
                        <td className="py-1.5 pr-2">
                          <EntryLocation entry={entry} />
                        </td>
                        <td className="py-1.5 pr-2">
                          {entry.origin === 'shared' ? 'Shared' : 'This machine'}
                          {entry.overridden && <span className="block text-xs text-fg-subtle">(overridden here)</span>}
                        </td>
                        <td className="py-1.5">
                          <div className="flex justify-end gap-1">
                            {!invalid && entry.kind !== 'none' && !entry.overridden && (
                              <Button variant="ghost" onClick={() => void testEntry(entry)}>
                                Test
                              </Button>
                            )}
                            {!invalid && (
                              <Button variant="ghost" onClick={() => edit(entry)}>
                                Edit
                              </Button>
                            )}
                            <Button variant="ghost" onClick={() => void remove(entry)}>
                              Remove
                            </Button>
                          </div>
                          {result !== undefined && (
                            <p
                              role="status"
                              className={`mt-1 text-right text-xs ${result.ok ? 'text-fg-subtle' : 'text-status-danger'}`}
                            >
                              {result.ok ? `OK, ${result.length} characters` : result.message}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {form !== undefined && state?.open === true && (
            <form
              className="mt-3 border-t border-hairline pt-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <p className="text-sm text-fg-default">
                {form.editing === undefined ? 'Add a secret source' : `Edit ${form.editing.name}`}
              </p>
              {topIssues.map((issue, index) => (
                <p key={index} role="alert" className="mt-1 text-xs text-status-danger">
                  {issue.reason}
                </p>
              ))}
              <div className="mt-2 grid grid-cols-[6rem_1fr] items-center gap-x-2 gap-y-1.5">
                <label htmlFor={`${baseId}-name`} className="text-sm text-fg-subtle">
                  Secret name
                </label>
                <input
                  id={`${baseId}-name`}
                  autoFocus
                  value={form.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  className={`font-mono ${INPUT_CLASS}`}
                />
                <label htmlFor={`${baseId}-scope`} className="text-sm text-fg-subtle">
                  Scope
                </label>
                <select
                  id={`${baseId}-scope`}
                  value={form.scope}
                  disabled={form.editing !== undefined}
                  onChange={(event) => {
                    const scope = event.target.value as Scope;
                    patch({ scope, ...(scope === 'shared' && form.kind === 'none' ? { kind: 'vault' } : {}) });
                  }}
                  className={INPUT_CLASS}
                >
                  <option value="shared">Shared</option>
                  <option value="local">This machine</option>
                </select>
                <label htmlFor={`${baseId}-kind`} className="text-sm text-fg-subtle">
                  Kind
                </label>
                <select
                  id={`${baseId}-kind`}
                  value={form.kind}
                  onChange={(event) => patch({ kind: event.target.value, values: {} })}
                  className={INPUT_CLASS}
                >
                  {kinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                {fieldsOf(form.kind).map((field) => {
                  const optional = KIND_FIELDS[form.kind]?.optional.includes(field) === true;
                  const fieldIssues = issues.filter((issue) => issue.field === field);
                  const inputId = `${baseId}-f-${field}`;
                  return (
                    <FieldRow
                      key={field}
                      id={inputId}
                      field={field}
                      optional={optional}
                      value={form.values[field] ?? ''}
                      issues={fieldIssues}
                      onChange={(value) => patch({ values: { ...form.values, [field]: value } })}
                    />
                  );
                })}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button onClick={() => setForm(undefined)} disabled={saving}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={saving || form.name.length === 0}>
                  Save
                </Button>
              </div>
            </form>
          )}

          {error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-status-danger">
              {error}
            </p>
          )}

          <div className="mt-3 flex justify-between">
            <Button
              disabled={state?.open !== true || form !== undefined}
              onClick={() => {
                setIssues([]);
                setForm(blankForm(''));
              }}
            >
              Add
            </Button>
            <Dialog.Close asChild>
              <Button>Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The fields a kind's form shows: its required ones, then its optional ones. */
function fieldsOf(kind: string | undefined): readonly string[] {
  const fields = kind === undefined ? undefined : KIND_FIELDS[kind];
  return fields === undefined ? [] : [...fields.required, ...fields.optional];
}

function FieldRow(props: {
  readonly id: string;
  readonly field: string;
  readonly optional: boolean;
  readonly value: string;
  readonly issues: readonly Issue[];
  readonly onChange: (value: string) => void;
}) {
  const { id, field, optional, value, issues, onChange } = props;
  const describedBy = [optional ? `${id}-hint` : undefined, ...issues.map((_, index) => `${id}-issue-${index}`)]
    .filter((part) => part !== undefined)
    .join(' ');
  return (
    <>
      <label htmlFor={id} className="text-sm text-fg-subtle">
        {field}
      </label>
      <div>
        <input
          id={id}
          value={value}
          aria-invalid={issues.length > 0}
          {...(describedBy.length > 0 ? { 'aria-describedby': describedBy } : {})}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full font-mono ${INPUT_CLASS}`}
        />
        {optional && (
          <span id={`${id}-hint`} className="text-xs text-fg-subtle">
            (optional)
          </span>
        )}
        {issues.map((issue, index) => (
          <p key={index} id={`${id}-issue-${index}`} className="text-xs text-status-danger">
            {issue.reason}
          </p>
        ))}
      </div>
    </>
  );
}
