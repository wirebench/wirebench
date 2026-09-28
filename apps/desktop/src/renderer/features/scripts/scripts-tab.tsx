/**
 * A request's **Scripts** tab (#63): the pre-request and post-response scripts, the secrets they may
 * read, and their timeout. Shared by the SOAP, REST and gRPC editors.
 *
 * Edits are written through to main as the request's properties are, not staged with the rest of
 * the request: a script is its own file, and the checker answering the editor reads main's copy of
 * the request. A switched-off script shows a banner and a **Switch on** button, the one deliberate
 * step an imported script needs before it runs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { Button } from '../../components/button.js';
import { BooleanSetting, NumberSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { Tabs } from '../../components/tabs.js';
import { showToast } from '../../components/toast.js';
import { CodeEditor } from '../../editor/code-editor.js';
import {
  clearScriptModelTarget,
  refreshScriptDiagnostics,
  registerScriptLanguageOnce,
  scriptModelPath,
  setScriptModelTarget,
  type ScriptPhase,
} from '../../editor/script-language.js';
import { useProjectStore } from '../../state/project.js';
import type { RequestScriptsPatchWire, RequestScriptsWire } from '../../../shared/wire-types.js';

/** Long enough that a burst of keystrokes is one write, short enough that a send right after sees it. */
const COMMIT_DEBOUNCE_MS = 300;
/** How long typing pauses before the checker is asked again. */
const CHECK_DEBOUNCE_MS = 400;
/** The engine's cap on a script's timeout. */
const MAX_TIMEOUT_MS = 10_000;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PHASES = [
  { id: 'pre', label: 'Pre-request' },
  { id: 'post', label: 'Post-response' },
] as const;

const PROBLEM_TEXT: Record<'script-file-missing' | 'script-too-large', string> = {
  'script-file-missing': 'file is missing',
  'script-too-large': 'is over the 256 KiB limit',
};

/** Whether a request has any script text, for the tab's dot. */
export function hasScripts(scripts: RequestScriptsWire | undefined): boolean {
  return (scripts?.pre ?? '') !== '' || (scripts?.post ?? '') !== '';
}

/** The names in a comma- or space-separated list, and the ones that are not secret names. */
export function parseSecretNames(text: string): { readonly names: string[]; readonly invalid: string[] } {
  const parts = text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return {
    names: [...new Set(parts.filter((part) => SECRET_NAME.test(part)))],
    invalid: parts.filter((part) => !SECRET_NAME.test(part)),
  };
}

export interface ScriptsTabProps {
  readonly requestId: string;
  readonly scripts: RequestScriptsWire | undefined;
}

/** The Scripts tab. */
export function ScriptsTab({ requestId, scripts }: ScriptsTabProps) {
  const updateRequestScripts = useProjectStore((state) => state.updateRequestScripts);
  const [phase, setPhase] = useState<ScriptPhase>('pre');
  const api = scripts?.api ?? 'wirebench';

  const write = useCallback(
    (patch: RequestScriptsPatchWire) => {
      updateRequestScripts(requestId, patch).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Could not save the scripts');
      });
    },
    [requestId, updateRequestScripts],
  );

  const items = PHASES.map((item) =>
    (scripts?.[item.id] ?? '') !== '' ? { ...item, badge: '●' } : { id: item.id, label: item.label },
  );

  return (
    <div data-testid="scripts-tab" className="flex h-full min-h-0 flex-1 flex-col">
      {scripts?.enabled === false && (
        <div
          role="status"
          data-testid="scripts-off-banner"
          className="flex shrink-0 items-center gap-3 border-b border-hairline bg-surface-sunken px-3 py-2 text-sm"
        >
          <span className="flex-1">These scripts are off. Read them, then switch them on.</span>
          <Button
            variant="primary"
            data-testid="scripts-switch-on"
            onClick={() => {
              write({ enabled: true });
            }}
          >
            Switch on
          </Button>
        </div>
      )}
      {scripts?.problems?.map((problem) => (
        <p
          key={problem.phase}
          role="alert"
          className="shrink-0 border-b border-hairline px-3 py-1 text-xs text-status-danger"
          data-testid={`scripts-problem-${problem.phase}`}
        >
          The {problem.phase === 'pre' ? 'pre-request' : 'post-response'} script {PROBLEM_TEXT[problem.code]}; the
          request will not send until it is fixed.
        </p>
      ))}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline">
        <Tabs label="Scripts" items={items} active={phase} onSelect={setPhase} />
        <span className="px-3 text-xs text-fg-faint">
          {api === 'postman' ? 'JavaScript · Postman layer' : 'TypeScript'}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ScriptEditor
          key={`${requestId}:${phase}:${api}`}
          requestId={requestId}
          phase={phase}
          api={api}
          value={scripts?.[phase] ?? ''}
          onCommit={(text) => {
            const next = text === '' ? null : text;
            write(phase === 'pre' ? { pre: next } : { post: next });
          }}
        />
      </div>
      <div className="shrink-0 overflow-auto border-t border-hairline">
        <SettingsGroup>
          <BooleanSetting
            label="Run these scripts"
            value={scripts?.enabled ?? true}
            disabled={!hasScripts(scripts)}
            testId="scripts-enabled"
            onChange={(enabled) => {
              write({ enabled });
            }}
          />
          <TextSetting
            label="Secrets"
            value={(scripts?.secrets ?? []).join(', ')}
            placeholder="signing_key, api_token"
            hint="The secrets a script may read with secrets.get. Listing one is a change a reviewer sees."
            monospace
            testId="scripts-secrets"
            onCommit={(text) => {
              const { names, invalid } = parseSecretNames(text);
              if (invalid.length > 0) {
                showToast(`Not a secret name: ${invalid.join(', ')}`);
                return;
              }
              write({ secrets: names });
            }}
          />
          <NumberSetting
            label="Timeout (ms)"
            value={scripts?.timeoutMs}
            placeholder="1000"
            min={1}
            hint={`Per script, up to ${String(MAX_TIMEOUT_MS)} ms.`}
            testId="scripts-timeout"
            onCommit={(value) => {
              write({ timeoutMs: value === undefined ? null : Math.min(Math.max(1, value), MAX_TIMEOUT_MS) });
            }}
          />
        </SettingsGroup>
      </div>
    </div>
  );
}

export interface ScriptEditorProps {
  readonly requestId: string;
  readonly phase: ScriptPhase;
  readonly api: 'wirebench' | 'postman';
  readonly value: string;
  readonly onCommit: (text: string) => void;
}

/**
 * One script's editor. It keeps what is typed locally and writes it after a pause; the request's
 * text coming back from main is taken only when it is not this editor's own last write, so a
 * keystroke made meanwhile survives the echo.
 */
export function ScriptEditor({ requestId, phase, api, value, onCommit }: ScriptEditorProps) {
  const [local, setLocal] = useState(value);
  const [errors, setErrors] = useState<number | undefined>(undefined);
  const committed = useRef(value);
  const pending = useRef<string | undefined>(undefined);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  const modelRef = useRef<Monaco.editor.ITextModel | undefined>(undefined);

  const check = useCallback(() => {
    const monacoNS = monacoRef.current;
    const model = modelRef.current;
    if (monacoNS === undefined || model === undefined) {
      return;
    }
    void refreshScriptDiagnostics(monacoNS, model).then((diagnostics) => {
      setErrors(diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length);
    });
  }, []);

  const flush = useCallback(() => {
    clearTimeout(commitTimer.current);
    const text = pending.current;
    if (text === undefined) {
      return;
    }
    pending.current = undefined;
    committed.current = text;
    onCommitRef.current(text);
  }, []);

  useEffect(() => {
    if (value === committed.current) {
      return;
    }
    clearTimeout(commitTimer.current);
    pending.current = undefined;
    committed.current = value;
    setLocal(value);
  }, [value]);

  useEffect(
    () => () => {
      flush();
      clearTimeout(checkTimer.current);
      const model = modelRef.current;
      if (model !== undefined) {
        clearScriptModelTarget(model.uri.toString());
      }
    },
    [flush],
  );

  const onMount = useCallback<OnMount>(
    (editor, monacoNS) => {
      const model = editor.getModel() ?? undefined;
      monacoRef.current = monacoNS as typeof Monaco;
      modelRef.current = model;
      registerScriptLanguageOnce(monacoNS as typeof Monaco);
      if (model !== undefined) {
        setScriptModelTarget(model.uri.toString(), { requestId, phase });
        check();
      }
    },
    [requestId, phase, check],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <CodeEditor
          ariaLabel={`${phase === 'pre' ? 'Pre-request' : 'Post-response'} script`}
          language={api === 'postman' ? 'javascript' : 'typescript'}
          path={scriptModelPath(requestId, phase, api)}
          value={local}
          onMount={onMount}
          onChange={(next) => {
            setLocal(next);
            pending.current = next;
            clearTimeout(commitTimer.current);
            commitTimer.current = setTimeout(flush, COMMIT_DEBOUNCE_MS);
            clearTimeout(checkTimer.current);
            checkTimer.current = setTimeout(check, CHECK_DEBOUNCE_MS);
          }}
        />
      </div>
      {errors !== undefined && errors > 0 && (
        <p role="status" data-testid="script-errors" className="shrink-0 px-3 py-1 text-xs text-status-danger">
          {errors === 1 ? '1 error' : `${String(errors)} errors`} — the request will not send until{' '}
          {errors === 1 ? 'it is' : 'they are'} fixed.
        </p>
      )}
    </div>
  );
}
