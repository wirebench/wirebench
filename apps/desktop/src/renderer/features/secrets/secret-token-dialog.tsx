import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { secretNameError } from '../../state/secret-review.js';
import { useUiStore } from '../../state/ui.js';

/** One token as `secretScan.tokens` lists it: a name, and whether this machine has its value. */
interface TokenStatus {
  readonly name: string;
  readonly stored: boolean;
}

const INPUT_CLASS =
  'rounded border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';

/**
 * *Set Secret Token Value…*: the `${secret:name}` tokens of one project, whether this machine has a
 * value for each, and a masked field to type one in — for a token someone else added (a teammate's
 * commit, an import), or to replace a value that changed.
 *
 * A value lives in this component's state only while it is typed: it goes to main through
 * `secretScan.setValue` and is cleared as soon as that call returns. Nothing sends one back.
 *
 * Opened on a name (a send refused for it), that name's row is open for its value even when main
 * does not list it: `secretScan.tokens` reads the saved project, and a token typed into a request
 * and sent without saving is only in the renderer's draft.
 *
 * Escape while a row is being edited cancels that edit and leaves the dialog open; with no edit
 * open it closes the dialog, as anywhere else.
 */
export function SecretTokenDialog() {
  const target = useUiStore((state) => state.secretTokenDialog);
  const setTarget = useUiStore((state) => state.setSecretTokenDialog);
  const projects = useProjectStore((state) => state.projects);
  const order = useProjectStore((state) => state.order);
  const projectId = target?.projectId;

  const [tokens, setTokens] = useState<readonly TokenStatus[] | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  /** The name the dialog was opened on, when main does not list it (it is only in unsaved edits). */
  const [unlisted, setUnlisted] = useState<string | undefined>(undefined);
  /** The project the latest load is for, so a reply for one the person has moved off is dropped. */
  const current = useRef<string | undefined>(undefined);
  /** Where focus goes once a save's refresh has rendered: a row's button, or the add form's Name. */
  const focusAfterSave = useRef<string | undefined>(undefined);
  const baseId = useId();
  const nameId = `${baseId}-name`;
  const rowButtonId = (name: string): string => `${baseId}-row-${name}`;

  const choices = order.map((entry) => entry.projectId).filter((id) => projects[id] !== undefined);

  const load = async (id: string): Promise<readonly TokenStatus[] | undefined> => {
    const result = await ipc().secretScan.tokens({ projectId: id });
    if (current.current !== id) {
      return undefined;
    }
    if (!result.ok) {
      setError(result.error.message);
      return undefined;
    }
    setTokens(result.value.tokens);
    return result.value.tokens;
  };

  useEffect(() => {
    current.current = projectId;
    setTokens(undefined);
    setDraft('');
    setNewName('');
    setNewValue('');
    setAnnouncement('');
    setError(undefined);
    setEditing(target?.name);
    setUnlisted(target?.name);
    focusAfterSave.current = undefined;
    if (projectId === undefined) {
      return;
    }
    void load(projectId);
  }, [projectId, target?.name]);

  useEffect(() => {
    const id = focusAfterSave.current;
    if (id === undefined || saving) {
      return;
    }
    const element = document.getElementById(id);
    if (element !== null) {
      focusAfterSave.current = undefined;
      element.focus();
    }
  });

  /** The listed tokens, with the name the dialog was opened on first when main does not list it. */
  const rows: readonly TokenStatus[] | undefined =
    tokens === undefined || unlisted === undefined || tokens.some((token) => token.name === unlisted)
      ? tokens
      : [{ name: unlisted, stored: false }, ...tokens];

  /**
   * Stores `value` for `name`; `clear` runs the moment the call returns, success or not. A reply
   * for a project the person has since moved off changes nothing on the one now shown.
   */
  const save = async (name: string, value: string, clear: () => void): Promise<boolean> => {
    if (projectId === undefined || value.length === 0 || saving) {
      return false;
    }
    setSaving(true);
    setAnnouncement('');
    const result = await ipc().secretScan.setValue({ projectId, name, value });
    clear();
    setSaving(false);
    if (current.current !== projectId) {
      return false;
    }
    if (!result.ok) {
      setError(result.error.message);
      return false;
    }
    setError(undefined);
    setAnnouncement(`Saved ${name}`);
    await load(projectId);
    return current.current === projectId;
  };

  const cancelEdit = (): void => {
    setDraft('');
    setEditing(undefined);
  };

  const saveRow = async (name: string): Promise<void> => {
    if (await save(name, draft, () => setDraft(''))) {
      focusAfterSave.current = rowButtonId(name);
      setEditing(undefined);
    }
  };

  const newNameError = newName.length === 0 ? undefined : secretNameError(newName);
  const canAdd = newName.length > 0 && newNameError === undefined && newValue.length > 0 && !saving;
  const saveNew = async (): Promise<void> => {
    if (!canAdd) {
      return;
    }
    if (await save(newName, newValue, () => setNewValue(''))) {
      focusAfterSave.current = nameId;
      setNewName('');
    }
  };

  return (
    <Dialog.Root
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) {
          setTarget(null);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="secret-token-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[32rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
          onEscapeKeyDown={(event) => {
            if (editing !== undefined) {
              event.preventDefault();
              cancelEdit();
            }
          }}
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Secret token values</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            A value is stored on this machine only; the project keeps the{' '}
            <code className="font-mono">{'${secret:name}'}</code> token.
          </Dialog.Description>

          {choices.length > 1 && (
            <>
              <label className="mt-3 block text-sm text-fg-subtle" htmlFor={`${baseId}-project`}>
                Project
              </label>
              <select
                id={`${baseId}-project`}
                value={projectId}
                onChange={(event) => setTarget({ projectId: event.target.value })}
                className={`mt-1 w-full ${INPUT_CLASS}`}
              >
                {choices.map((id) => (
                  <option key={id} value={id}>
                    {projects[id]?.name ?? id}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {rows === undefined ? (
              error === undefined && <p className="text-sm text-fg-subtle">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-fg-subtle">This project uses no secret tokens.</p>
            ) : (
              <ul>
                {rows.map((token) => (
                  <li
                    key={token.name}
                    data-testid="secret-token-row"
                    data-name={token.name}
                    className="flex items-center gap-2 border-b border-hairline py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-default">{token.name}</span>
                    {editing === token.name ? (
                      <>
                        <input
                          type="password"
                          autoFocus
                          aria-label={`Value for ${token.name}`}
                          value={draft}
                          disabled={saving}
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void saveRow(token.name);
                            }
                          }}
                          placeholder="Enter value"
                          className={`w-48 ${INPUT_CLASS}`}
                        />
                        <Button onClick={() => void saveRow(token.name)} disabled={saving || draft.length === 0}>
                          Save
                        </Button>
                        <Button onClick={cancelEdit} disabled={saving}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="shrink-0 text-xs text-fg-subtle">
                          {token.stored ? 'Set' : 'Not on this machine'}
                        </span>
                        <Button
                          id={rowButtonId(token.name)}
                          aria-label={`${token.stored ? 'Replace' : 'Set'} value for ${token.name}`}
                          disabled={saving}
                          onClick={() => {
                            setDraft('');
                            setAnnouncement('');
                            setEditing(token.name);
                          }}
                        >
                          {token.stored ? 'Replace…' : 'Set…'}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 border-t border-hairline pt-3">
            <p className="text-sm text-fg-default">Set a value for another name</p>
            <div className="mt-1.5 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <label className="sr-only" htmlFor={nameId}>
                  Name
                </label>
                <input
                  id={nameId}
                  value={newName}
                  placeholder="Name"
                  disabled={saving}
                  aria-invalid={newNameError !== undefined}
                  {...(newNameError === undefined ? {} : { 'aria-describedby': `${baseId}-name-error` })}
                  onChange={(event) => setNewName(event.target.value)}
                  className={`w-full font-mono aria-[invalid=true]:border-status-danger ${INPUT_CLASS}`}
                />
              </div>
              <label className="sr-only" htmlFor={`${baseId}-value`}>
                Value
              </label>
              <input
                id={`${baseId}-value`}
                type="password"
                value={newValue}
                placeholder="Value"
                disabled={saving}
                onChange={(event) => setNewValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveNew();
                  }
                }}
                className={`w-40 ${INPUT_CLASS}`}
              />
              <Button data-testid="secret-token-add-save" disabled={!canAdd} onClick={() => void saveNew()}>
                Save
              </Button>
            </div>
            {newNameError !== undefined && (
              <p id={`${baseId}-name-error`} className="mt-1 text-xs text-status-danger">
                {newNameError}
              </p>
            )}
          </div>

          <p
            role="status"
            aria-live="polite"
            data-testid="secret-token-announce"
            className="mt-2 text-xs text-fg-subtle"
          >
            {announcement}
          </p>
          {error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-status-danger">
              {error}
            </p>
          )}

          <div className="mt-3 flex justify-end">
            <Dialog.Close asChild>
              <Button>Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
