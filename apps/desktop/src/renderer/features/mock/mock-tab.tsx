/**
 * The mock tab (#59): a mock's settings and its Start/Stop, its operations, the selected operation's
 * dispatch and responses, the selected response, the stubs the contract does not allow (#325), and the
 * requests it answered.
 *
 * Like a sequence tab, every committed edit is applied at once through `project.mutate` and main
 * validates it against the rules a mock file is held to; a refused edit is reported and the field snaps
 * back. A running mock restarts with each edit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { showToast } from '../../components/toast.js';
import {
  EnumSetting,
  NumberSetting,
  ReadOnlySetting,
  SettingsGroup,
  TextSetting,
} from '../../components/settings-grid.js';
import { CodeEditor } from '../../editor/code-editor.js';
import {
  clearScriptModelTarget,
  dispatchScriptModelPath,
  refreshScriptDiagnostics,
  registerScriptLanguageOnce,
  setScriptModelTarget,
} from '../../editor/script-language.js';
import { useMockRunsStore } from '../../state/mock-runs.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useProjectStore } from '../../state/project.js';
import type {
  MockDispatchWire,
  MockOperationPatch,
  MockOperationWire,
  MockPatch,
  MockResponsePatch,
  MockValidationWire,
  MockWire,
} from '../../../shared/wire-types.js';
import { SelectField } from '../sequence/step-fields.js';
import { MockLog } from './mock-log.js';
import { MockResponseEditor } from './mock-response-editor.js';
import { MockStubCheck } from './mock-stub-check.js';

export interface MockTabProps {
  readonly mockId: string;
}

const VALIDATION_OPTIONS: readonly { value: MockValidationWire; label: string }[] = [
  { value: 'reject', label: 'Refuse a request that breaks the contract' },
  { value: 'report', label: 'Answer anyway and log the problems' },
  { value: 'off', label: 'Do not check requests' },
];

const DISPATCH_OPTIONS: readonly { value: MockDispatchWire; label: string }[] = [
  { value: 'sequence', label: 'In order' },
  { value: 'random', label: 'At random' },
  { value: 'match', label: 'By match conditions' },
  { value: 'script', label: 'By script' },
];

/** How long typing pauses before the checker is asked again. */
const CHECK_DEBOUNCE_MS = 400;

/** The starter a script gets when an operation switches to script dispatch with none. */
const SCRIPT_STARTER = `// \`request\`: method, path, query, headers, pathParams and body.
// \`responses\`: this operation's responses, { id, name }. \`scenarios.get(name)\` / \`scenarios.set(name, state)\`.
// Answer with respond(name); when nothing is picked, the default response is sent.
const first = responses[0];
if (first !== undefined) {
  respond(first.name);
}
`;

function bindingLabel(binding: string | undefined): string | undefined {
  if (binding === undefined) return undefined;
  const close = binding.indexOf('}');
  return close === -1 ? binding : binding.slice(close + 1);
}

function useHandlers(mockId: string) {
  const store = useProjectStore();
  const report = (error: unknown): void => {
    showToast(error instanceof Error ? error.message : String(error));
  };
  return {
    mock: (patch: MockPatch): void => {
      store.updateMock(mockId, patch).catch(report);
    },
    operation: (operationId: string, patch: MockOperationPatch): void => {
      store.updateMockOperation(mockId, operationId, patch).catch(report);
    },
    response: (operationId: string, responseId: string, patch: MockResponsePatch): void => {
      store.updateMockResponse(mockId, operationId, responseId, patch).catch(report);
    },
    add: (operationId: string, copyOf?: string): Promise<string | undefined> =>
      store.addMockResponse(mockId, operationId, copyOf).catch((error: unknown) => {
        report(error);
        return undefined;
      }),
    remove: (operationId: string, responseId: string): void => {
      store.removeMockResponse(mockId, operationId, responseId).catch(report);
    },
    move: (operationId: string, responseId: string, to: number): void => {
      store.moveMockResponse(mockId, operationId, responseId, to).catch(report);
    },
  };
}

function RunBar({ mock }: { readonly mock: MockWire }) {
  const state = useMockRunsStore((s) => s.states[mock.id]);
  const busy = useMockRunsStore((s) => s.busy[mock.id] === true);
  const { start, stop, reset } = useMockRunsStore.getState();
  const exposedPreference = usePreferencesStore((s) => s.preferences.mocks.listenOnAllInterfaces);
  const running = state?.running === true;
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <button
            type="button"
            data-testid="mock-stop"
            disabled={busy}
            className="h-row rounded-md border border-hairline-strong px-3 text-md text-fg-default hover:bg-surface-hover disabled:opacity-50"
            onClick={() => void stop(mock.id)}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            data-testid="mock-start"
            disabled={busy}
            className="h-row rounded-md bg-accent px-3 text-md text-fg-on-accent disabled:opacity-50"
            onClick={() => void start(mock.id)}
          >
            Start
          </button>
        )}
        {running && state.url !== undefined && (
          <>
            <code
              data-testid="mock-url"
              className="rounded bg-surface-base px-2 py-0.5 font-mono text-sm text-fg-default"
            >
              {state.url}
            </code>
            <button
              type="button"
              data-testid="mock-copy-url"
              className="text-sm text-accent hover:underline"
              onClick={() => {
                void navigator.clipboard.writeText(state.url ?? '').catch(() => {
                  showToast('Could not copy to the clipboard');
                });
              }}
            >
              Copy
            </button>
            <button
              type="button"
              data-testid="mock-reset"
              className="text-sm text-accent hover:underline"
              onClick={() => void reset(mock.id)}
            >
              Reset state
            </button>
          </>
        )}
        {!running && <span className="text-xs text-fg-subtle">Stopped.</span>}
      </div>
      {state?.error !== undefined && (
        <p data-testid="mock-error" className="text-sm text-status-danger">
          {state.error}
        </p>
      )}
      {(running ? state.exposed === true : exposedPreference) && (
        <p data-testid="mock-exposed-warning" className="text-sm text-status-warning">
          Mocks listen on every network interface (Preferences → Mock services): anything that can reach this machine
          can call this mock.
        </p>
      )}
      {running &&
        state.warnings.map((warning) => (
          <p key={warning.message} className="text-xs text-status-warning">
            {warning.message}
          </p>
        ))}
    </div>
  );
}

/**
 * The operation's `dispatch.ts`. Main's checker answers its completion, hover and diagnostics against
 * the dispatch API, with `respond` taking the operation's response names (#352); it checks the text
 * being typed, and again when the responses change.
 */
function ScriptEditor({
  mockId,
  operation,
  onCommit,
}: {
  readonly mockId: string;
  readonly operation: MockOperationWire;
  readonly onCommit: (script: string) => void;
}) {
  const [draft, setDraft] = useState(operation.script ?? SCRIPT_STARTER);
  const [errors, setErrors] = useState<number | undefined>(undefined);
  const dirty = draft !== (operation.script ?? '');
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  const modelRef = useRef<Monaco.editor.ITextModel | undefined>(undefined);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  const responseNames = operation.responses.map((response) => response.name).join('\n');
  useEffect(check, [check, responseNames]);

  useEffect(
    () => () => {
      clearTimeout(checkTimer.current);
      const model = modelRef.current;
      if (model !== undefined) {
        clearScriptModelTarget(model.uri.toString());
      }
    },
    [],
  );

  const onMount = useCallback<OnMount>(
    (editor, monacoNS) => {
      const model = editor.getModel() ?? undefined;
      monacoRef.current = monacoNS as typeof Monaco;
      modelRef.current = model;
      registerScriptLanguageOnce(monacoNS as typeof Monaco);
      if (model !== undefined) {
        setScriptModelTarget(model.uri.toString(), { mockId, operationId: operation.id });
        check();
      }
    },
    [mockId, operation.id, check],
  );

  return (
    <div data-testid="mock-script" className="flex flex-col gap-1">
      <p className="text-xs text-fg-subtle">
        <code className="font-mono">dispatch.ts</code> runs in a sandbox with no network, files, secrets or properties.
        It sees <code className="font-mono">request</code>, <code className="font-mono">responses</code> and{' '}
        <code className="font-mono">scenarios</code>, and answers with <code className="font-mono">respond(name)</code>;
        when it picks none, the default response is sent.
      </p>
      <div className="h-56 min-h-0">
        <CodeEditor
          key={operation.id}
          value={draft}
          language="typescript"
          ariaLabel="Dispatch script"
          path={dispatchScriptModelPath(mockId, operation.id)}
          onMount={onMount}
          onChange={(next) => {
            setDraft(next);
            clearTimeout(checkTimer.current);
            checkTimer.current = setTimeout(check, CHECK_DEBOUNCE_MS);
          }}
        />
      </div>
      {errors !== undefined && errors > 0 && (
        <p role="status" data-testid="mock-script-errors" className="text-xs text-status-danger">
          {errors === 1 ? '1 error' : `${String(errors)} errors`} in the script.
        </p>
      )}
      <div>
        <button
          type="button"
          data-testid="mock-script-save"
          disabled={!dirty}
          className="h-row rounded-md border border-hairline-strong px-3 text-sm text-fg-default hover:bg-surface-hover disabled:opacity-40"
          onClick={() => onCommit(draft)}
        >
          Apply script
        </button>
      </div>
    </div>
  );
}

function OperationPane({
  mock,
  operation,
  handlers,
}: {
  readonly mock: MockWire;
  readonly operation: MockOperationWire;
  readonly handlers: ReturnType<typeof useHandlers>;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = operation.responses.find((response) => response.id === selectedId) ?? operation.responses[0];
  const index = selected === undefined ? -1 : operation.responses.indexOf(selected);
  const defaultOptions = [
    { value: '', label: 'None' },
    ...operation.responses.map((response) => ({ value: response.id, label: response.name })),
  ];

  return (
    <div data-testid="mock-operation" className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm text-fg-default">{operation.operation}</span>
        <label className="flex items-center gap-1 text-sm text-fg-muted">
          Pick a response
          <SelectField
            label="Dispatch"
            testId="mock-dispatch"
            value={operation.dispatch}
            options={DISPATCH_OPTIONS}
            onChange={(dispatch) =>
              handlers.operation(operation.id, {
                dispatch,
                ...(dispatch === 'script' && operation.script === undefined ? { script: SCRIPT_STARTER } : {}),
              })
            }
          />
        </label>
        <label className="flex items-center gap-1 text-sm text-fg-muted">
          Default
          <SelectField
            label="Default response"
            testId="mock-default-response"
            value={operation.defaultResponseId ?? ''}
            options={defaultOptions}
            onChange={(id) => handlers.operation(operation.id, { defaultResponseId: id === '' ? null : id })}
          />
        </label>
      </div>

      {operation.dispatch === 'script' && (
        <ScriptEditor
          mockId={mock.id}
          operation={operation}
          onCommit={(script) => handlers.operation(operation.id, { script })}
        />
      )}

      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium text-fg-default">Responses</h3>
        <ol data-testid="mock-responses" className="flex flex-col">
          {operation.responses.map((response, at) => (
            <li
              key={response.id}
              data-testid="mock-response"
              aria-selected={response.id === selected?.id}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm ${
                response.id === selected?.id ? 'bg-surface-selected' : 'hover:bg-surface-hover'
              }`}
            >
              <button
                type="button"
                data-testid="mock-response-select"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => setSelectedId(response.id)}
              >
                <span className="w-10 shrink-0 font-mono text-xs text-fg-subtle">{response.status}</span>
                <span className="truncate text-fg-default">{response.name}</span>
                {response.id === operation.defaultResponseId && (
                  <span className="shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle">default</span>
                )}
                {response.scenario !== undefined && (
                  <span className="shrink-0 truncate text-xs text-fg-subtle">
                    {response.scenario.name}
                    {response.scenario.state !== undefined ? `: ${response.scenario.state}` : ''}
                    {response.scenario.next !== undefined ? ` → ${response.scenario.next}` : ''}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label={`Move ${response.name} up`}
                disabled={at === 0}
                className="rounded px-1 text-fg-subtle hover:text-fg-default disabled:opacity-30"
                onClick={() => handlers.move(operation.id, response.id, at - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${response.name} down`}
                disabled={at === operation.responses.length - 1}
                className="rounded px-1 text-fg-subtle hover:text-fg-default disabled:opacity-30"
                onClick={() => handlers.move(operation.id, response.id, at + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove ${response.name}`}
                className="rounded px-1 text-fg-subtle hover:text-fg-default"
                onClick={() => handlers.remove(operation.id, response.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
        <div className="flex gap-3">
          <button
            type="button"
            data-testid="mock-response-add"
            className="text-sm text-accent hover:underline"
            onClick={() => {
              void handlers.add(operation.id).then((id) => setSelectedId(id));
            }}
          >
            Add response
          </button>
          <button
            type="button"
            data-testid="mock-response-duplicate"
            disabled={selected === undefined}
            className="text-sm text-accent hover:underline disabled:opacity-40"
            onClick={() => {
              if (selected !== undefined) void handlers.add(operation.id, selected.id).then((id) => setSelectedId(id));
            }}
          >
            Duplicate
          </button>
        </div>
      </div>

      {selected !== undefined && (
        <SettingsGroup
          title={`Response ${String(index + 1)}: ${selected.name}`}
          {...(mock.validation === 'off'
            ? {}
            : { hint: 'Requests are checked against the contract before a response is picked.' })}
        >
          <MockResponseEditor
            key={selected.id}
            response={selected}
            dispatch={operation.dispatch}
            onPatch={(patch) => handlers.response(operation.id, selected.id, patch)}
          />
        </SettingsGroup>
      )}
    </div>
  );
}

/** One mock's page. */
export function MockTab({ mockId }: MockTabProps) {
  const mock = useProjectStore((state) => state.mocks[mockId]);
  const container = useProjectStore((state) => {
    const id = mock?.source.containerId;
    if (id === undefined) return undefined;
    return state.interfaces[id]?.name ?? state.apis[id]?.name;
  });
  const handlers = useHandlers(mockId);
  const [operationId, setOperationId] = useState<string | undefined>(undefined);

  if (mock === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This mock is no longer in the project.</p>;
  }
  const operation = mock.operations.find((candidate) => candidate.id === operationId) ?? mock.operations[0];
  const binding = bindingLabel(mock.source.binding);

  return (
    <section aria-label={`Mock ${mock.name}`} data-testid="mock-tab" className="h-full overflow-auto p-3">
      <SettingsGroup title="Mock">
        <TextSetting
          label="Name"
          testId="mock-name"
          value={mock.name}
          onCommit={(name) => {
            if (name.trim().length > 0) handlers.mock({ name: name.trim() });
          }}
        />
        <ReadOnlySetting
          label="Contract"
          testId="mock-contract"
          value={`${container ?? 'Missing interface or API'}${binding !== undefined ? ` · ${binding}` : ''}`}
        />
        <NumberSetting
          label="Port"
          testId="mock-port"
          value={mock.port}
          min={0}
          max={65_535}
          hint="0 takes any free port."
          onCommit={(port) => handlers.mock({ port: port ?? 0 })}
        />
        <TextSetting
          label="Path"
          testId="mock-path"
          monospace
          value={mock.path}
          onCommit={(path) => handlers.mock({ path: path.trim() === '' ? '/' : path.trim() })}
        />
        <EnumSetting
          label="Contract check"
          testId="mock-validation"
          value={mock.validation}
          options={VALIDATION_OPTIONS}
          onChange={(validation) => handlers.mock({ validation: validation as MockValidationWire })}
        />
        <RunBar mock={mock} />
      </SettingsGroup>

      <SettingsGroup title="Operations">
        {mock.operations.length === 0 ? (
          <p className="text-sm text-fg-subtle">This mock has no operations.</p>
        ) : (
          <div className="flex gap-3">
            <ul data-testid="mock-operations" className="flex w-56 shrink-0 flex-col">
              {mock.operations.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    data-testid="mock-operation-row"
                    aria-selected={candidate.id === operation?.id}
                    className={`flex w-full flex-col rounded-md px-2 py-1 text-left text-sm ${
                      candidate.id === operation?.id ? 'bg-surface-selected' : 'hover:bg-surface-hover'
                    }`}
                    onClick={() => setOperationId(candidate.id)}
                  >
                    <span className="truncate text-fg-default">{candidate.name}</span>
                    <span className="truncate text-xs text-fg-subtle">
                      {DISPATCH_OPTIONS.find((option) => option.value === candidate.dispatch)?.label} ·{' '}
                      {String(candidate.responses.length)} response{candidate.responses.length === 1 ? '' : 's'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {operation !== undefined && (
              <OperationPane key={operation.id} mock={mock} operation={operation} handlers={handlers} />
            )}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Stubs against the contract"
        hint="Each response's status, headers and body, checked as a received response is."
      >
        <MockStubCheck mock={mock} onSelect={setOperationId} />
      </SettingsGroup>

      <SettingsGroup title="Requests" hint="What this mock answered this session; credentials are masked.">
        <MockLog mockId={mock.id} />
      </SettingsGroup>
    </section>
  );
}
