/**
 * The snippet in the right panel (where host details show on the Hosts view): name, package, tags,
 * description, the script with its `${…}` tokens marked, the declared variables, Press Enter and Always
 * confirm. Every save sends the whole file through `ssh.saveSnippets`; a secret is inserted by name only.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { Plus, X } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { CodeEditor } from '../../../editor/code-editor.js';
import type { SshSecretNameWire } from '../../../../shared/ssh-wire.js';
import type { SnippetVariableWire, SnippetWire, SnippetsFileWire } from '../../../../shared/snippets-wire.js';
import { ipc } from '../../../state/ipc-client.js';
import { INPUT_CLASS } from '../inherited-field.js';
import { startRun } from './run.js';
import { addPackage, freeSnippetId, scriptTokens, undeclaredTokens, upsertSnippet } from './snippet-edit.js';
import { useSnippetsStore } from './snippets-store.js';

/** The package picker's choices that are not a package id. */
const NO_PACKAGE = '';
const NEW_PACKAGE = '\u0000new';
/** The secret picker's "New secret…" choice. */
const NEW_SECRET = '\u0000new';

const TOKEN_CLASS = {
  variable: 'wb-snippet-variable',
  secret: 'wb-snippet-secret',
  shell: 'wb-snippet-shell',
} as const;

/** The snippet with `id`, and the package holding it. */
function locate(file: SnippetsFileWire, id: string): { snippet: SnippetWire; packageId?: string } | undefined {
  for (const pkg of file.packages) {
    const snippet = pkg.snippets.find((s) => s.id === id);
    if (snippet !== undefined) return { snippet, packageId: pkg.id };
  }
  const snippet = file.snippets.find((s) => s.id === id);
  return snippet === undefined ? undefined : { snippet };
}

export function SnippetEditor() {
  const target = useSnippetsStore((s) => s.editor);
  const file = useSnippetsStore((s) => s.file);
  if (target === null) return null;
  if (target.mode === 'new') {
    return <SnippetForm key={`new:${target.packageId ?? ''}`} file={file} packageId={target.packageId} />;
  }
  const found = locate(file, target.id);
  if (found === undefined) return null;
  return <SnippetForm key={target.id} file={file} snippet={found.snippet} packageId={found.packageId} />;
}

interface VariableRow {
  /** A stable key for the row while its name is edited. */
  readonly key: number;
  readonly name: string;
  readonly label: string;
  readonly default: string;
}

function Field({ label, children }: { readonly label: string; readonly children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-xs">
      <label htmlFor={id} className="text-fg-subtle">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function Switch(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const { label, checked, onChange } = props;
  return (
    <div className="flex items-center justify-between gap-2 text-sm text-fg-default">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-hairline-strong px-0.5 transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none ${checked ? 'justify-end bg-accent' : 'justify-start bg-surface-base'}`}
        onClick={() => {
          onChange(!checked);
        }}
      >
        <span className="size-2.5 rounded-full bg-fg-default" />
      </button>
    </div>
  );
}

function SnippetForm(props: {
  readonly file: SnippetsFileWire;
  readonly snippet?: SnippetWire;
  readonly packageId: string | undefined;
}) {
  const { file, snippet } = props;
  const save = useSnippetsStore((s) => s.save);
  const openEditor = useSnippetsStore((s) => s.openEditor);
  const [name, setName] = useState(snippet?.name ?? '');
  const [packageChoice, setPackageChoice] = useState(props.packageId ?? NO_PACKAGE);
  const [newPackage, setNewPackage] = useState('');
  const [tags, setTags] = useState(snippet?.tags.join(', ') ?? '');
  const [description, setDescription] = useState(snippet?.description ?? '');
  const [script, setScript] = useState(snippet?.script ?? '');
  const nextKey = useRef(0);
  const row = (v: { name: string; label?: string | undefined; default?: string | undefined }): VariableRow => ({
    key: nextKey.current++,
    name: v.name,
    label: v.label ?? '',
    default: v.default ?? '',
  });
  const [variables, setVariables] = useState<VariableRow[]>(() => (snippet?.variables ?? []).map(row));
  const [enter, setEnter] = useState(snippet?.enter ?? true);
  const [confirm, setConfirm] = useState(snippet?.confirm ?? false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  /** A Run or Insert waiting for the user to save the edits first: a run types the saved snippet. */
  const [pendingRun, setPendingRun] = useState<{ enter?: false }>();
  const snapshot = JSON.stringify([
    name,
    packageChoice,
    newPackage,
    tags,
    description,
    script,
    variables.map((v) => [v.name, v.label, v.default]),
    enter,
    confirm,
  ]);
  const [savedSnapshot, setSavedSnapshot] = useState(snapshot);
  const dirty = snapshot !== savedSnapshot;
  const [secretNames, setSecretNames] = useState<readonly SshSecretNameWire[]>([]);
  const [newSecret, setNewSecret] = useState<{ name: string; value: string; error?: string }>();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor>(null);
  const decorations = useRef<Monaco.editor.IEditorDecorationsCollection>(null);
  const monacoRef = useRef<typeof Monaco>(null);

  const loadSecretNames = async (): Promise<void> => {
    const result = await ipc().ssh.secretNames(undefined);
    if (result.ok) setSecretNames(result.value.names);
  };
  useEffect(() => {
    loadSecretNames().catch(() => undefined); // the picker stays empty; "New secret…" still works
  }, []);

  // The three token styles follow the script and the declared names.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    const monaco = monacoRef.current;
    if (decorations.current === null || model === null || model === undefined || monaco === null) return;
    if (typeof model.getPositionAt !== 'function') return;
    decorations.current.set(
      scriptTokens(script, variables).map((t) => {
        const start = model.getPositionAt(t.start);
        const end = model.getPositionAt(t.end);
        return {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: { inlineClassName: TOKEN_CLASS[t.kind] },
        };
      }),
    );
  }, [script, variables]);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco as typeof Monaco;
    decorations.current =
      typeof editor.createDecorationsCollection === 'function' ? editor.createDecorationsCollection() : null;
  };

  /** At the cursor when the editor has one, else at the end. */
  const insert = (text: string): void => {
    const editor = editorRef.current;
    const selection = typeof editor?.getSelection === 'function' ? editor.getSelection() : null;
    if (editor !== null && selection !== null) {
      editor.executeEdits('snippets', [{ range: selection, text, forceMoveMarkers: true }]);
      editor.focus();
      return;
    }
    setScript((current) => current + text);
  };

  const storeSecret = async (): Promise<void> => {
    if (newSecret === undefined) return;
    const secret = newSecret.name.trim();
    if (secret === '') return;
    // Write-only: the value goes to main and is never read back; the script only ever gets the name.
    const result = await ipc().ssh.setSecret({ name: secret, value: newSecret.value });
    if (!result.ok) {
      setNewSecret({ name: newSecret.name, value: '', error: result.error.message });
      return;
    }
    setNewSecret(undefined);
    insert(`\${secret:${secret}}`);
    await loadSecretNames();
  };

  const undeclared = undeclaredTokens(script, variables);
  const canSave =
    name.trim() !== '' && script.trim() !== '' && (packageChoice !== NEW_PACKAGE || newPackage.trim() !== '');

  /** Saves the form; whether it was saved. */
  const submit = async (): Promise<boolean> => {
    let next = file;
    let packageId: string | undefined = packageChoice === NO_PACKAGE ? undefined : packageChoice;
    if (packageChoice === NEW_PACKAGE) {
      const added = addPackage(next, newPackage);
      next = added.file;
      packageId = added.id;
    }
    const id = snippet?.id ?? freeSnippetId(next, name);
    const tagList = [
      ...new Set(
        tags
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t !== ''),
      ),
    ];
    const declared: SnippetVariableWire[] = variables.map((v) => ({
      name: v.name.trim(),
      ...(v.label.trim() === '' ? {} : { label: v.label.trim() }),
      ...(v.default === '' ? {} : { default: v.default }),
    }));
    const edited: SnippetWire = {
      id,
      name: name.trim(),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      tags: tagList,
      variables: declared,
      script,
      enter,
      confirm,
    };
    setSaving(true);
    setError(undefined);
    try {
      const answer = await save(upsertSnippet(next, packageId, edited));
      if (!answer.ok) {
        setError(answer.error.message);
        return false;
      }
      setSavedSnapshot(snapshot);
      openEditor({ mode: 'edit', id });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Runs the saved snippet by id, as it is in the list now. */
  const runSaved = (id: string, opts: { enter?: false }): void => {
    const item = useSnippetsStore.getState().snippets.find((x) => x.id === id);
    if (item !== undefined) startRun(item, opts);
  };
  const run = (opts: { enter?: false }): void => {
    if (snippet === undefined) return;
    if (dirty) setPendingRun(opts);
    else runSaved(snippet.id, opts);
  };

  const setVariable = (key: number, patch: Partial<Omit<VariableRow, 'key'>>): void => {
    setVariables((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  return (
    <form
      aria-label={snippet === undefined ? 'New snippet' : `Edit ${snippet.name}`}
      data-testid="snippet-editor"
      className="flex flex-col gap-3 px-1 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && !saving) void submit();
      }}
    >
      <h3 className="text-sm font-medium text-fg-default">{snippet === undefined ? 'New snippet' : snippet.name}</h3>
      <Field label="Name">
        {(id) => (
          <input
            id={id}
            className={INPUT_CLASS}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Package">
        {(id) => (
          <select
            id={id}
            className={INPUT_CLASS}
            value={packageChoice}
            onChange={(e) => {
              setPackageChoice(e.target.value);
            }}
          >
            <option value={NO_PACKAGE}>No package</option>
            {file.packages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PACKAGE}>New package…</option>
          </select>
        )}
      </Field>
      {packageChoice === NEW_PACKAGE && (
        <Field label="New package name">
          {(id) => (
            <input
              id={id}
              className={INPUT_CLASS}
              value={newPackage}
              onChange={(e) => {
                setNewPackage(e.target.value);
              }}
            />
          )}
        </Field>
      )}
      <Field label="Tags">
        {(id) => (
          <input
            id={id}
            className={INPUT_CLASS}
            placeholder="deploy, logs"
            value={tags}
            onChange={(e) => {
              setTags(e.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Description">
        {(id) => (
          <input
            id={id}
            className={INPUT_CLASS}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
          />
        )}
      </Field>
      <div className="flex flex-col gap-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-fg-subtle">Script</span>
          <select
            aria-label="Insert secret"
            className={`${INPUT_CLASS} max-w-44`}
            value=""
            onChange={(e) => {
              const choice = e.target.value;
              if (choice === NEW_SECRET) setNewSecret({ name: '', value: '' });
              else if (choice !== '') insert(`\${secret:${choice}}`);
            }}
          >
            <option value="">Insert secret…</option>
            {secretNames.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
              </option>
            ))}
            <option value={NEW_SECRET}>New secret…</option>
          </select>
        </div>
        <div className="h-40 overflow-hidden rounded border border-hairline-strong">
          <CodeEditor
            value={script}
            language="text"
            ariaLabel="Script"
            lineNumbers={false}
            onChange={setScript}
            onMount={onMount}
          />
        </div>
      </div>
      {newSecret !== undefined && (
        <div className="flex flex-col gap-2 rounded-md border border-hairline p-2">
          <Field label="Secret name">
            {(id) => (
              <input
                id={id}
                className={`${INPUT_CLASS} font-mono`}
                value={newSecret.name}
                onChange={(e) => {
                  setNewSecret({ ...newSecret, name: e.target.value });
                }}
              />
            )}
          </Field>
          <Field label="Secret value">
            {(id) => (
              <input
                id={id}
                type="password"
                autoComplete="off"
                className={INPUT_CLASS}
                value={newSecret.value}
                onChange={(e) => {
                  setNewSecret({ ...newSecret, value: e.target.value });
                }}
              />
            )}
          </Field>
          {newSecret.error !== undefined && <p className="text-xs text-status-danger">{newSecret.error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setNewSecret(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                void storeSecret();
              }}
            >
              Store and insert
            </Button>
          </div>
        </div>
      )}
      {undeclared.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {undeclared.map((token) => (
            <li key={token}>
              <button
                type="button"
                className="rounded border border-hairline px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-raised"
                onClick={() => {
                  setVariables((rows) => [...rows, row({ name: token })]);
                }}
              >
                {`Declare \${${token}} as a variable`}
              </button>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="flex min-w-0 flex-col gap-2 text-xs">
        <legend className="mb-1 text-fg-subtle">Variables</legend>
        {/* Below 360px of panel width a row stacks: name and remove on one line, Label and Default under them. */}
        {variables.map((v) => (
          <div
            key={v.key}
            data-testid="snippet-variable-row"
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1 @min-[360px]:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <input
              aria-label="Variable name"
              className={`${INPUT_CLASS} order-1 col-span-2 min-w-0 font-mono @min-[360px]:order-none @min-[360px]:col-span-1`}
              value={v.name}
              onChange={(e) => {
                setVariable(v.key, { name: e.target.value });
              }}
            />
            <input
              aria-label={`Label of ${v.name}`}
              placeholder="Label"
              className={`${INPUT_CLASS} order-3 min-w-0 @min-[360px]:order-none`}
              value={v.label}
              onChange={(e) => {
                setVariable(v.key, { label: e.target.value });
              }}
            />
            <input
              aria-label={`Default of ${v.name}`}
              placeholder="Default"
              className={`${INPUT_CLASS} order-4 min-w-0 @min-[360px]:order-none`}
              value={v.default}
              onChange={(e) => {
                setVariable(v.key, { default: e.target.value });
              }}
            />
            <button
              type="button"
              aria-label={`Remove ${v.name}`}
              className="order-2 inline-flex size-6 items-center @min-[360px]:order-none justify-center rounded text-fg-subtle hover:bg-surface-hover"
              onClick={() => {
                setVariables((rows) => rows.filter((r) => r.key !== v.key));
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
        <Button
          className="self-start"
          onClick={() => {
            setVariables((rows) => [...rows, row({ name: '' })]);
          }}
        >
          <Plus size={12} aria-hidden="true" /> Add variable
        </Button>
      </fieldset>
      <Switch label="Press Enter" checked={enter} onChange={setEnter} />
      <Switch label="Always confirm" checked={confirm} onChange={setConfirm} />
      {error !== undefined && (
        <p role="alert" className="rounded border border-status-danger px-2 py-1 text-sm text-fg-default">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {snippet !== undefined && (
          <>
            <Button
              onClick={() => {
                run({});
              }}
            >
              Run
            </Button>
            <Button
              onClick={() => {
                run({ enter: false });
              }}
            >
              Insert
            </Button>
          </>
        )}
        <Button variant="primary" type="submit" disabled={!canSave || saving}>
          Save
        </Button>
      </div>
      <ConfirmDialog
        open={pendingRun !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingRun(undefined);
        }}
        title="Save changes first?"
        description="A run types the saved snippet. Save your changes, then run it."
        confirmLabel="Save and run"
        onConfirm={() => {
          const opts = pendingRun ?? {};
          if (snippet === undefined || !canSave) return;
          submit()
            .then((saved) => {
              if (saved) runSaved(snippet.id, opts);
            })
            .catch(() => undefined); // submit shows its own error
        }}
      />
    </form>
  );
}
