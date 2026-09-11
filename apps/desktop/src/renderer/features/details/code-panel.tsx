/**
 * The Details panel's Code tab: the `curl` command that would send the request the user is
 * looking at, regenerated as they edit it. Main owns the generation (`request.curl`, the same
 * builder `request.send` uses), so what is shown is what would actually go on the wire — and
 * is redacted by main unless "Show secrets" is on.
 */

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ImportCurlDialog } from '../request-editor/import-curl-dialog.js';
import { useEditorsStore } from '../../state/editors.js';
import { useGlobalsStore } from '../../state/globals.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { useSecretsVisibilityStore } from '../../state/secrets-visibility.js';
import { useUiStore } from '../../state/ui.js';
import type { CodeShell } from '../../state/ui-state.js';

/** Long enough that a burst of keystrokes is one IPC round trip, short enough to feel live. */
const DEBOUNCE_MS = 300;

/** Must match `REDACTED_MARKER` in `main/redact.ts` — the renderer may not import from main. */
const REDACTED_MARKER = '<redacted>';

const SHELLS: readonly { readonly value: CodeShell; readonly label: string }[] = [
  { value: 'posix', label: 'POSIX shell' },
  { value: 'powershell', label: 'PowerShell' },
];

/**
 * Which request the panel describes: an explicit explorer selection wins, otherwise the active
 * request tab — the same rule `SelectionDetails` follows, so both halves of the panel agree.
 */
function useCodePanelRequestId(): string | undefined {
  const selected = useUiStore((state) => (state.selection?.kind === 'request' ? state.selection.requestId : undefined));
  const active = useEditorsStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.requestId);
  return selected ?? active;
}

/** What the last `request.curl` call produced: the command, or the failure to show in its place. */
interface Generated {
  readonly command: string;
  readonly error: boolean;
  /** One-line notes about layers this command does not carry (WS-Security, attachments). */
  readonly notes: readonly string[];
}

export function CodePanel() {
  const requestId = useCodePanelRequestId();
  const shell = useUiStore((state) => state.details.codeShell);
  const setShell = useUiStore((state) => state.setDetailsCodeShell);
  const showSecrets = useSecretsVisibilityStore((state) => state.show);
  const draft = useProjectStore((state) => (requestId === undefined ? undefined : state.requests[requestId]));
  // Main builds the command from `buildLiveSendInput` + `effectiveSendInput`, which resolve the
  // active environment's endpoint override and expand `${...}` references against environment,
  // project and global properties — so the preview must regenerate on any of those, not just on
  // edits to the request draft itself.
  const activeEnvironmentId = useProjectStore((state) => state.activeEnvironmentId);
  const projectProperties = useProjectStore((state) => state.project?.properties);
  const environments = useProjectStore((state) => state.environments);
  const interfaceEndpoints = useProjectStore((state) =>
    draft === undefined ? undefined : state.interfaces[draft.interfaceId]?.endpoints,
  );
  const globalProperties = useGlobalsStore((state) => state.properties);
  const [generated, setGenerated] = useState<Generated | undefined>(undefined);
  // The panel owns its own dialog instance (rather than reusing the request editor's) because it
  // must be able to follow an explorer-selected request whose editor tab is not mounted at all.
  const [importOpen, setImportOpen] = useState(false);

  // Every input the command depends on, flattened into one value the effect can compare — the
  // draft object identity changes on any store write, including ones that cannot alter a `curl`.
  const draftKey = JSON.stringify([
    draft?.envelopeXml,
    draft?.endpointId,
    draft?.endpointUrl,
    draft?.soapAction,
    draft?.soapVersion,
    draft?.headers,
    draft?.auth,
    draft?.properties,
    activeEnvironmentId,
    projectProperties,
    environments,
    interfaceEndpoints,
    globalProperties,
  ]);

  // Answers can land out of order (a slow first call, a fast second); only the newest may win.
  const sequence = useRef(0);
  // The request the panel last generated for, so switching requests shows a command at once
  // rather than after the edit debounce.
  const generatedFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (requestId === undefined) {
      setGenerated(undefined);
      generatedFor.current = undefined;
      return;
    }
    const immediate = generatedFor.current !== requestId;
    generatedFor.current = requestId;
    const token = (sequence.current += 1);

    const generate = async (): Promise<void> => {
      const result = await ipc().request.curl({ requestId, shell });
      if (token !== sequence.current) {
        return;
      }
      setGenerated(
        result.ok
          ? { command: result.value.command, error: false, notes: result.value.notes ?? [] }
          : { command: result.error.message, error: true, notes: [] },
      );
    };

    if (immediate) {
      // Switching requests must not show (or let Copy hand out) the previous request's command
      // even for the one round trip before the new one lands.
      setGenerated(undefined);
      void generate();
      return;
    }
    const timer = setTimeout(() => {
      void generate();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [requestId, shell, draftKey, showSecrets]);

  if (requestId === undefined) {
    return (
      <div data-testid="code-panel">
        <p className="text-md text-fg-muted">Open a request to see its cURL command</p>
        <p className="mt-1 text-sm text-fg-subtle">
          The Code tab follows the request you are editing, or the one selected in the Explorer.
        </p>
      </div>
    );
  }

  const command = generated?.command ?? '';
  const copy = async (): Promise<void> => {
    if (generated === undefined || generated.error) {
      return;
    }
    try {
      await navigator.clipboard.writeText(generated.command);
      showToast(shell === 'powershell' ? 'Copied as cURL (PowerShell)' : 'Copied as cURL');
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : 'Could not copy to the clipboard');
    }
  };

  return (
    <div data-testid="code-panel" className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="text-sm text-fg-subtle" htmlFor="code-panel-shell">
          Shell
        </label>
        <select
          id="code-panel-shell"
          aria-label="Shell"
          data-testid="code-panel-shell"
          value={shell}
          onChange={(event) => {
            setShell(event.target.value as CodeShell);
          }}
          className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default"
        >
          {SHELLS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <pre
        data-testid="code-panel-preview"
        className={`max-h-[60vh] overflow-auto rounded-md border border-hairline bg-surface-sunken p-2 font-mono text-xs break-all whitespace-pre-wrap select-text ${
          generated?.error === true ? 'text-status-danger' : 'text-fg-default'
        }`}
      >
        {command}
      </pre>

      {command.includes(REDACTED_MARKER) && (
        <p className="text-xs text-fg-subtle">Secrets are masked unless Show secrets is on.</p>
      )}

      {generated !== undefined &&
        !generated.error &&
        generated.notes.map((note) => (
          <p key={note} data-testid="code-panel-note" className="text-xs text-fg-subtle">
            {note}
          </p>
        ))}

      <div className="flex items-center gap-2">
        <Button
          data-testid="code-panel-copy"
          disabled={generated === undefined || generated.error}
          onClick={() => {
            void copy();
          }}
        >
          Copy
        </Button>
        <Button
          data-testid="code-panel-import"
          onClick={() => {
            setImportOpen(true);
          }}
        >
          Import cURL…
        </Button>
      </div>

      {draft !== undefined && (
        <ImportCurlDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          operation={{
            interfaceId: draft.interfaceId,
            bindingName: draft.bindingName,
            operationName: draft.operationName,
          }}
        />
      )}
    </div>
  );
}
