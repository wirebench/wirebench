/**
 * The run dialog (spec D9.4) for one terminal: the variables form, the terminal to type into, the script as
 * it will be typed (secrets as `••••`, from main), the note on secrets and a warning for a protected host.
 * In `variables` mode (the terminal in front, nothing else to ask) it is the variables form alone.
 */
import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { ipc } from '../../../state/ipc-client.js';
import type { OpenTerminal, RunRequest } from './run.js';
import { closeRunDialog, openTerminals, runInTerminal, showTerminal, useRunDialogStore } from './run.js';
import { lastValues } from './snippets-prefs.js';
import { useSnippetsStore } from './snippets-store.js';
import { VariablesForm, anyInvalid, initialValues } from './variables-form.js';

export const SECRET_NOTE = 'Typed with a leading space so most shells keep it out of history; hidden on screen';

/** How long the values must stay still before the preview is asked for again. */
const PREVIEW_DEBOUNCE_MS = 150;

export function SnippetRunDialog() {
  const request = useRunDialogStore((s) => s.request);
  // Keyed, so each run starts from its own values and terminal.
  return (
    <Dialog.Root
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) closeRunDialog();
      }}
    >
      {request !== null && <RunDialogBody key={`${request.snippetId}:${String(request.enter)}`} request={request} />}
    </Dialog.Root>
  );
}

function RunDialogBody({ request }: { readonly request: RunRequest }) {
  const item = useSnippetsStore((s) => s.snippets.find((x) => x.id === request.snippetId));
  const [terminals] = useState<OpenTerminal[]>(() => openTerminals());
  const [tabId, setTabId] = useState<string | undefined>(() => request.tabId ?? terminals[0]?.tabId);
  const [values, setValues] = useState<Record<string, string>>(() =>
    initialValues(item?.variables ?? [], lastValues(request.snippetId)),
  );
  const [preview, setPreview] = useState<{ text?: string; error?: string }>({});
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const groupId = useId();
  const full = request.mode === 'dialog';
  const insert = request.enter === false;

  useEffect(() => {
    if (!full || item === undefined || anyInvalid(values)) return;
    let current = true;
    const timer = setTimeout(() => {
      void ipc()
        .ssh.previewSnippet({ snippetId: item.id, values })
        .then((answer) => {
          if (!current) return;
          setPreview(answer.ok ? { text: answer.value.text } : { error: answer.error.message });
        })
        .catch(() => undefined); // the preview stays as it was; the run itself still works
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [full, item, values]);

  const chosen = terminals.find((t) => t.tabId === tabId);
  const verb = insert ? 'Insert' : 'Run';
  const canRun = item !== undefined && chosen !== undefined && !anyInvalid(values) && !running;

  const submit = async (): Promise<void> => {
    if (item === undefined || chosen === undefined || anyInvalid(values)) return;
    setRunning(true);
    setError(undefined);
    try {
      await runInTerminal(chosen.tabId, item, values, insert ? { enter: false } : {});
      closeRunDialog();
      showTerminal(chosen.tabId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 bg-black/40" />
      <Dialog.Content
        data-testid="snippet-run-dialog"
        className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[28rem] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-md bg-surface-raised p-4 shadow-lg"
      >
        <Dialog.Title className="text-md font-medium text-fg-default">
          {item === undefined ? 'Snippet' : `${verb} ${item.name}`}
        </Dialog.Title>
        <Dialog.Description className="sr-only">
          The values, the terminal and the script as it will be typed.
        </Dialog.Description>
        {item === undefined ? (
          <p role="alert" className="text-sm text-fg-default">
            This snippet is no longer in snippets.yaml.
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <VariablesForm
              variables={item.variables}
              values={values}
              onChange={(name, value) => {
                setValues((current) => ({ ...current, [name]: value }));
              }}
            />
            {full && (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-xs font-medium text-fg-muted">Terminal</legend>
                {terminals.length === 0 ? (
                  <p className="text-sm text-fg-subtle">No terminal is connected. Connect to a host first.</p>
                ) : (
                  terminals.map((t) => (
                    <label key={t.tabId} className="flex items-center gap-2 text-sm text-fg-default">
                      <input
                        type="radio"
                        name={groupId}
                        checked={t.tabId === tabId}
                        onChange={() => {
                          setTabId(t.tabId);
                        }}
                      />
                      {t.label}
                    </label>
                  ))
                )}
              </fieldset>
            )}
            {full && chosen?.protected === true && (
              <p
                data-testid="snippet-run-protected"
                className="flex items-center gap-2 rounded border border-status-danger px-2 py-1 text-sm text-fg-default"
              >
                <ShieldAlert size={14} aria-hidden="true" />
                {`${chosen.label} is a protected host`}
              </p>
            )}
            {full && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-fg-muted">Script</span>
                <pre
                  data-testid="snippet-run-preview"
                  className="max-h-48 overflow-auto rounded border border-hairline bg-surface-base px-2 py-1 font-mono text-xs whitespace-pre-wrap text-fg-default"
                >
                  {preview.text ?? item.firstLine}
                </pre>
                {preview.error !== undefined && <span className="text-xs text-status-danger">{preview.error}</span>}
              </div>
            )}
            {full && item.secrets.length > 0 && <p className="text-xs text-fg-subtle">{SECRET_NOTE}</p>}
            {error !== undefined && (
              <p role="alert" className="rounded border border-status-danger px-2 py-1 text-sm text-fg-default">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={closeRunDialog}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={!canRun}>
                {verb}
              </Button>
            </div>
          </form>
        )}
      </Dialog.Content>
    </Dialog.Portal>
  );
}
