/**
 * The Code slide-over's body: the request the user is looking at as a `curl` command, as code in
 * another language, or as the `wirebench run` line that sends it — regenerated as they edit it.
 * Main owns the generation (`request.curl` and `request.code`, both over the resolved send), so
 * what is shown is what would actually go on the wire, and a credential is masked (`curl`) or read
 * from the environment (every other language) unless "Show secrets" is on.
 */

import { useEffect, useRef, useState } from 'react';
import { GENERATED_CODE_TARGETS, isPluginCodeTarget } from '@shared/code-targets.js';
import type {
  CodeLanguage,
  CodeSettings,
  CodeTarget,
  GeneratedCodeTarget,
  PluginCodeTarget,
} from '@shared/code-targets.js';
import { Button } from '../components/button.js';
import { showToast } from '../components/toast.js';
import { ImportCurlDialog } from '../features/request-editor/import-curl-dialog.js';
import { useEditorsStore } from '../state/editors.js';
import { useCurrentValuesStore } from '../state/current-values.js';
import { useGlobalsStore } from '../state/globals.js';
import { ipc } from '../state/ipc-client.js';
import { grpcDraftPatch, restDraftPatch, useProjectStore, wsDraftPatch } from '../state/project.js';
import { selectActiveEnvironmentId, useWorkspaceStore } from '../state/workspace.js';
import { highlightCurl, type CurlTokenKind } from './curl-highlight.js';
import { useSecretsVisibilityStore } from '../state/secrets-visibility.js';
import { useUiStore } from '../state/ui.js';
import type { CodeShell } from '../state/ui-state.js';

/** Long enough that a burst of keystrokes is one IPC round trip, short enough to feel live. */
const DEBOUNCE_MS = 300;

/**
 * Must match `REDACTED_MARKER` and `REDACTED_XML_MARKER` in the engine — the renderer may not import
 * from main. A SOAP envelope's masked password carries the XML form.
 */
const REDACTED_MARKERS = ['<redacted>', '&lt;redacted&gt;'];

/**
 * How each span of the command is painted. Only the flags carry the accent: in a command that is
 * mostly one long quoted string per line, colouring the strings too would leave nothing plain to
 * read the shape against.
 */
const TOKEN_CLASS: Readonly<Record<CurlTokenKind, string>> = {
  command: 'font-semibold text-fg-default',
  flag: 'text-accent',
  string: 'text-fg-default',
  punctuation: 'text-fg-faint',
  body: 'text-fg-muted',
  plain: 'text-fg-subtle',
};

const SELECT_CLASS =
  'h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default';

/** The prefix of the variables the CLI reads secrets from, and so the ones a snippet reads. */
const SECRET_ENV_PREFIX = 'WIREBENCH_SECRET_';

/** The picker's value for `curl` in one shell: the two share one language and differ by quoting. */
type PickerValue = `curl:${CodeShell}` | CodeTarget;

/** The picker's entries for a REST or SOAP request: `curl` in either shell, every language, then `wirebench run`. */
const LANGUAGE_OPTIONS: readonly { readonly value: PickerValue; readonly label: string }[] = [
  { value: 'curl:posix', label: 'cURL — POSIX shell' },
  { value: 'curl:powershell', label: 'cURL — PowerShell' },
  ...GENERATED_CODE_TARGETS.map((target) => ({ value: target.id, label: target.label })),
  { value: 'wirebench-run', label: 'wirebench run' },
];

/** A gRPC or WebSocket request has its own command only, in either shell. */
const COMMAND_OPTIONS: readonly { readonly value: PickerValue; readonly label: string }[] = [
  { value: 'curl:posix', label: 'Command — POSIX shell' },
  { value: 'curl:powershell', label: 'Command — PowerShell' },
];

/** The language a generated target is, when the value names one; `wirebench run` has no layout to set. */
function generatedTarget(language: CodeLanguage): GeneratedCodeTarget | undefined {
  return GENERATED_CODE_TARGETS.find((target) => target.id === language)?.id;
}

/** What one language reads as in a toast. */
function languageLabel(
  language: CodeLanguage,
  shell: CodeShell,
  plugins: readonly { readonly id: string; readonly label: string }[],
): string {
  if (language === 'curl') return shell === 'powershell' ? 'cURL (PowerShell)' : 'cURL';
  if (language === 'wirebench-run') return 'wirebench run';
  return (
    GENERATED_CODE_TARGETS.find((target) => target.id === language)?.label ??
    plugins.find((target) => target.id === language)?.label ??
    language
  );
}

/**
 * The plugin code generators this run has on (phase 7 §9), asked of main once per panel: only their
 * ids and titles reach the renderer. A plugin is installed or removed for the next start, so the list
 * does not change while the app runs.
 */
function usePluginCodeTargets(): readonly { readonly id: PluginCodeTarget; readonly label: string }[] {
  const [targets, setTargets] = useState<readonly { readonly id: PluginCodeTarget; readonly label: string }[]>([]);
  useEffect(() => {
    let current = true;
    void Promise.resolve()
      .then(() => ipc().request.codeTargets(undefined))
      .then((result) => {
        if (!current || !result.ok) return;
        setTargets(
          result.value.targets.flatMap((target) =>
            isPluginCodeTarget(target.id) ? [{ id: target.id, label: `${target.label} (plugin)` }] : [],
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return targets;
}

/**
 * Which request the panel describes: an explicit explorer selection wins, otherwise the active
 * request tab — the same rule the request pane's own inspectors follow, so both agree.
 */
function useCodePanelRequestId(): string | undefined {
  const selected = useUiStore((state) => (state.selection?.kind === 'request' ? state.selection.requestId : undefined));
  const active = useEditorsStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.requestId);
  return selected ?? active;
}

/**
 * The REST request the panel would describe, when that is what is in front of the user.
 *
 * Kept apart from the SOAP id only so the panel knows which model an edit should re-trigger on;
 * `request.curl` itself takes either, and dispatches on what the id names.
 */
function useCodePanelRestRequestId(): string | undefined {
  const selected = useUiStore((state) =>
    state.selection?.kind === 'rest-request' ? state.selection.requestId : undefined,
  );
  const active = useEditorsStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.restRequestId);
  return selected ?? active;
}

/** The gRPC request the panel would describe, on the same terms as the REST one. */
function useCodePanelGrpcRequestId(): string | undefined {
  const selected = useUiStore((state) =>
    state.selection?.kind === 'grpc-request' ? state.selection.requestId : undefined,
  );
  const active = useEditorsStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.grpcRequestId);
  return selected ?? active;
}

/** The WebSocket request the panel would describe, on the same terms as the gRPC one. */
function useCodePanelWsRequestId(): string | undefined {
  const selected = useUiStore((state) =>
    state.selection?.kind === 'ws-request' ? state.selection.requestId : undefined,
  );
  const active = useEditorsStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.wsRequestId);
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
  const pluginTargets = usePluginCodeTargets();
  const restRequestId = useCodePanelRestRequestId();
  const grpcRequestId = useCodePanelGrpcRequestId();
  const wsRequestId = useCodePanelWsRequestId();
  // Persisted on `slideOver.codeShell`: the slide-over hosts only the Code panel, so its shell
  // choice is remembered there rather than in a per-tab slot.
  const shell = useUiStore((state) => state.slideOver.codeShell);
  const setShell = useUiStore((state) => state.setCodeShell);
  // Remembered per user with the rest of the persisted layout, so the language picked last is
  // the one the panel opens in next time.
  const pickedLanguage = useUiStore((state) => state.slideOver.codeLanguage);
  const setLanguage = useUiStore((state) => state.setCodeLanguage);
  const allSettings = useUiStore((state) => state.slideOver.codeSettings);
  const setCodeSettings = useUiStore((state) => state.setCodeSettings);
  const showSecrets = useSecretsVisibilityStore((state) => state.show);
  const draft = useProjectStore((state) => (requestId === undefined ? undefined : state.requests[requestId]));
  // Main builds the command by resolving the request through the engine, which resolves the
  // active environment's endpoint override and expand `${...}` references against environment,
  // project and global properties — so the preview must regenerate on any of those, not just on
  // edits to the request draft itself.
  // The environment is the request's own project's (#468), whichever project is current.
  const ownerProjectId = useProjectStore((state) => {
    const id = requestId ?? restRequestId ?? grpcRequestId ?? wsRequestId;
    return id === undefined ? undefined : state.projectOf[id];
  });
  const activeEnvironmentId = useWorkspaceStore((state) => selectActiveEnvironmentId(state, ownerProjectId));
  const environments = useWorkspaceStore((state) => state.workspace?.environments);
  const projectProperties = useProjectStore((state) => {
    const projectId = requestId === undefined ? undefined : state.projectOf[requestId];
    return projectId === undefined ? undefined : state.projects[projectId]?.properties;
  });
  const interfaceEndpoints = useProjectStore((state) =>
    draft === undefined ? undefined : state.interfaces[draft.interfaceId]?.endpoints,
  );
  const globalProperties = useGlobalsStore((state) => state.properties);
  const currentValues = useCurrentValuesStore((state) => state.byScope);
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
    currentValues,
  ]);

  // The same, for a REST request: its own fields plus the API's base URL, which the command resolves.
  const restDraft = useProjectStore((state) =>
    restRequestId === undefined ? undefined : state.restRequests[restRequestId],
  );
  const restApiBaseUrl = useProjectStore((state) =>
    restDraft === undefined ? undefined : state.apis[restDraft.apiId]?.baseUrl,
  );
  const restApiName = useProjectStore((state) =>
    restDraft === undefined ? undefined : state.apis[restDraft.apiId]?.name,
  );
  const restDraftKey = JSON.stringify([
    restDraft?.method,
    restDraft?.url,
    restDraft?.pathParams,
    restDraft?.query,
    restDraft?.headers,
    restDraft?.body,
    restDraft?.auth,
    restDraft?.settings,
    restApiBaseUrl,
    activeEnvironmentId,
    environments,
    currentValues,
  ]);

  // And for a gRPC request: its own fields plus the API's target, which the command names.
  const grpcDraft = useProjectStore((state) =>
    grpcRequestId === undefined ? undefined : state.grpcRequests[grpcRequestId],
  );
  const grpcApiTarget = useProjectStore((state) =>
    grpcDraft === undefined ? undefined : state.grpcApis[grpcDraft.apiId]?.target,
  );
  const grpcDraftKey = JSON.stringify([
    grpcDraft?.service,
    grpcDraft?.method,
    grpcDraft?.metadata,
    grpcDraft?.message,
    grpcDraft?.auth,
    grpcDraft?.settings,
    grpcApiTarget,
    activeEnvironmentId,
    environments,
    currentValues,
  ]);

  // And for a WebSocket request: its own fields plus the API's server URL, which the command dials.
  const wsDraft = useProjectStore((state) => (wsRequestId === undefined ? undefined : state.wsRequests[wsRequestId]));
  const wsApiUrl = useProjectStore((state) => (wsDraft === undefined ? undefined : state.wsApis[wsDraft.apiId]?.url));
  const wsDraftKey = JSON.stringify([
    wsDraft?.url,
    wsDraft?.query,
    wsDraft?.headers,
    wsDraft?.subprotocols,
    wsDraft?.auth,
    wsDraft?.settings,
    wsApiUrl,
    activeEnvironmentId,
    environments,
    currentValues,
  ]);

  // Answers can land out of order (a slow first call, a fast second); only the newest may win.
  const sequence = useRef(0);
  // The request the panel last generated for, so switching requests shows a command at once
  // rather than after the edit debounce.
  const generatedFor = useRef<string | undefined>(undefined);

  // Whichever protocol's id the user is looking at: `request.curl` takes all four.
  const subject = requestId ?? restRequestId ?? grpcRequestId ?? wsRequestId;
  // Every language is for an HTTP request; a gRPC or WebSocket request keeps its own command.
  const codeable = requestId !== undefined || restRequestId !== undefined;
  const language: CodeLanguage = codeable ? pickedLanguage : 'curl';
  const target = generatedTarget(language);
  const settings: CodeSettings | undefined = target === undefined ? undefined : allSettings[target];
  const settingsKey = JSON.stringify(settings ?? null);

  useEffect(() => {
    if (subject === undefined) {
      setGenerated(undefined);
      generatedFor.current = undefined;
      return;
    }
    const immediate = generatedFor.current !== subject;
    generatedFor.current = subject;
    const token = (sequence.current += 1);

    const generate = async (): Promise<void> => {
      // A REST request's staged edits travel with the call, so the command describes what is on
      // screen rather than what was last written. A SOAP draft reaches main through its own path.
      const draft = restRequestId === undefined ? undefined : restDraftPatch(restRequestId);
      const grpcDraft = grpcRequestId === undefined ? undefined : grpcDraftPatch(grpcRequestId);
      const wsDraft = wsRequestId === undefined ? undefined : wsDraftPatch(wsRequestId);
      const result =
        language === 'curl'
          ? await ipc().request.curl({
              requestId: subject,
              shell,
              ...(draft !== undefined ? { draft } : {}),
              ...(grpcDraft !== undefined ? { grpcDraft } : {}),
              ...(wsDraft !== undefined ? { wsDraft } : {}),
            })
          : await ipc().request.code({
              requestId: subject,
              target: language,
              ...(settings !== undefined ? { settings } : {}),
              ...(draft !== undefined ? { draft } : {}),
            });
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
  }, [subject, shell, language, settingsKey, draftKey, restDraftKey, grpcDraftKey, wsDraftKey, showSecrets]);

  if (subject === undefined) {
    return (
      <div data-testid="code-panel">
        <p className="text-md text-fg-muted">Open a request to see its command</p>
        <p className="mt-1 text-sm text-fg-subtle">
          The Code panel follows the request you are editing, or the one selected in the Explorer.
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
      showToast(codeable ? `Copied as ${languageLabel(language, shell, pluginTargets)}` : 'Copied as command');
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : 'Could not copy to the clipboard');
    }
  };
  // A gRPC request has no cURL to import from: the command shown is a grpcurl-style one.
  const importable = draft !== undefined || restDraft !== undefined;

  return (
    <div data-testid="code-panel" className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="text-sm text-fg-subtle" htmlFor="code-panel-language">
          Language
        </label>
        <select
          id="code-panel-language"
          aria-label="Language"
          data-testid="code-panel-language"
          value={language === 'curl' ? `curl:${shell}` : language}
          onChange={(event) => {
            const value = event.target.value as PickerValue;
            if (value === 'curl:posix' || value === 'curl:powershell') {
              setLanguage('curl');
              setShell(value === 'curl:posix' ? 'posix' : 'powershell');
            } else {
              setLanguage(value);
            }
          }}
          className={SELECT_CLASS}
        >
          {(codeable
            ? [...LANGUAGE_OPTIONS, ...pluginTargets.map((target) => ({ value: target.id, label: target.label }))]
            : COMMAND_OPTIONS
          ).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {target !== undefined && (
        <CodeSettingsRow
          target={target}
          settings={settings}
          onChange={(next) => {
            setCodeSettings(target, next);
          }}
        />
      )}

      <pre
        data-testid="code-panel-preview"
        className={`max-h-[60vh] overflow-auto rounded-md border border-hairline bg-surface-sunken p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap select-text ${
          generated?.error === true ? 'text-status-danger' : 'text-fg-default'
        }`}
      >
        {/* A failure is prose, not shell: highlighting it would dress an error message up as a
            command. Only a real `curl` command is tokenised; other languages are shown plain. */}
        {generated?.error === true || language !== 'curl'
          ? command
          : highlightCurl(command).map((line, lineIndex) => (
              // Lines have no identity of their own — the command is regenerated whole on every
              // edit, so the index is the only key there is, and nothing is preserved across
              // renders that a better one would protect.
              <span key={lineIndex}>
                {lineIndex > 0 && '\n'}
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} className={TOKEN_CLASS[token.kind]}>
                    {token.text}
                  </span>
                ))}
              </span>
            ))}
      </pre>

      {REDACTED_MARKERS.some((marker) => command.includes(marker)) && (
        <p className="text-xs text-fg-subtle">Secrets are masked unless Show secrets is on.</p>
      )}
      {language !== 'curl' && command.includes(SECRET_ENV_PREFIX) && (
        <p className="text-xs text-fg-subtle">
          Secrets are read from WIREBENCH_SECRET_* environment variables unless Show secrets is on.
        </p>
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
        {importable && (
          <Button
            data-testid="code-panel-import"
            onClick={() => {
              setImportOpen(true);
            }}
          >
            Import cURL…
          </Button>
        )}
      </div>

      {/* The import lands wherever the panel is pointed: the SOAP operation in front of the user, or
          the API the REST request in front of them belongs to. */}
      {draft !== undefined && (
        <ImportCurlDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          target={{
            kind: 'soap',
            interfaceId: draft.interfaceId,
            bindingName: draft.bindingName,
            operationName: draft.operationName,
          }}
          targetLabel={`the ${draft.operationName} operation`}
        />
      )}
      {draft === undefined && restDraft !== undefined && (
        <ImportCurlDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          target={{
            kind: 'rest',
            apiId: restDraft.apiId,
            ...(restDraft.folderId !== undefined ? { folderId: restDraft.folderId } : {}),
          }}
          targetLabel={restApiName === undefined ? 'this API' : `the API “${restApiName}”`}
        />
      )}
    </div>
  );
}

/** One language's layout choices: indent, redirects and timeout. An unset choice takes the request's own. */
function CodeSettingsRow(props: {
  readonly target: GeneratedCodeTarget;
  readonly settings: CodeSettings | undefined;
  readonly onChange: (settings: CodeSettings | undefined) => void;
}) {
  const { target, settings, onChange } = props;
  const conventional = GENERATED_CODE_TARGETS.find((entry) => entry.id === target)?.indent ?? 2;
  const indent = settings?.indent ?? conventional;
  // Kept as typed while the field has focus, so clearing it to type a new value does not snap back.
  const [timeoutText, setTimeoutText] = useState<string | undefined>(undefined);
  const timeout = timeoutText ?? (settings?.timeoutMs === undefined ? '' : String(settings.timeoutMs / 1000));

  const change = (patch: Partial<Record<keyof CodeSettings, CodeSettings[keyof CodeSettings] | undefined>>): void => {
    const next: Record<string, unknown> = { ...settings, ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="code-panel-settings">
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        Indent
        <select
          aria-label="Indent"
          data-testid="code-panel-indent"
          value={String(indent)}
          onChange={(event) => {
            const value = event.target.value === 'tab' ? 'tab' : Number(event.target.value);
            change({ indent: value === conventional ? undefined : value });
          }}
          className="h-row rounded-md border border-hairline-strong bg-surface-raised px-1 text-xs text-fg-default"
        >
          <option value="2">2 spaces</option>
          <option value="4">4 spaces</option>
          <option value="tab">Tab</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        Redirects
        <select
          aria-label="Redirects"
          data-testid="code-panel-redirects"
          value={settings?.followRedirects === undefined ? 'request' : settings.followRedirects ? 'follow' : 'none'}
          onChange={(event) => {
            const value = event.target.value;
            change({ followRedirects: value === 'request' ? undefined : value === 'follow' });
          }}
          className="h-row rounded-md border border-hairline-strong bg-surface-raised px-1 text-xs text-fg-default"
        >
          <option value="request">As the request</option>
          <option value="follow">Follow</option>
          <option value="none">Don’t follow</option>
        </select>
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        Timeout (s)
        <input
          aria-label="Timeout in seconds"
          data-testid="code-panel-timeout"
          type="number"
          min={0}
          step="any"
          placeholder="As the request"
          value={timeout}
          onChange={(event) => {
            setTimeoutText(event.target.value);
            const seconds = Number(event.target.value);
            if (event.target.value.trim() === '') {
              change({ timeoutMs: undefined });
            } else if (Number.isFinite(seconds) && seconds >= 0) {
              change({ timeoutMs: Math.round(seconds * 1000) });
            }
          }}
          onBlur={() => {
            setTimeoutText(undefined);
          }}
          className="h-row w-24 rounded-md border border-hairline-strong bg-surface-raised px-1 text-xs text-fg-default"
        />
      </label>
    </div>
  );
}
