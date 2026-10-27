/**
 * Variables in the Monaco editors (#340): `${` completes the names a request can reference, hovering
 * a reference shows what it resolves to (masked when it reads a secret) with a link to edit it, an
 * unresolved one is marked, and **Set as Variable…** turns the selection into a variable.
 *
 * Monaco's providers are process-global, so they are registered once, for every language a body or a
 * response is shown in, and answer only for a model an editor attached with {@link attachVariableAssist}
 * — a script, a mock response or a definition never gets variable help. The rules themselves live in
 * the Monaco-free `variable-assist.ts`.
 */
import type * as Monaco from 'monaco-editor';
import { propertyReferences } from '@wirebench/engine/rest';
import type { VariableEditTargetWire } from '@shared/wire-base.js';
import { openVariableEditTarget } from '../features/environments/variable-edit-target.js';
import {
  classifyReference,
  completionContext,
  completionItems,
  hoverContent,
  unresolvedReferences,
  type HoverContent,
  type RequestVariables,
} from './variable-assist.js';

/** What an attached editor lends the providers. */
export interface VariableAssistSource {
  /** The request's variables, or `undefined` while they are still being fetched. */
  readonly variables: () => RequestVariables | undefined;
  /**
   * Opens **Set as Variable…** for `selected`. `replace` writes the reference over the selection; a
   * read-only editor (a response) passes none.
   */
  readonly onSetAsVariable?: (selected: string, replace: ((reference: string) => void) | undefined) => void;
}

/** The `setModelMarkers` owner of the unresolved-variable marks. */
export const VARIABLE_MARKER_OWNER = 'wirebench-variables';

/** The command a hover's **Edit** link runs. */
export const EDIT_VARIABLE_COMMAND = 'wirebench.variables.edit';

/** The languages a request body or a response is edited or shown in. */
const LANGUAGES = ['xml', 'json', 'plaintext'];

const sources = new Map<string, VariableAssistSource>();

/**
 * Monaco's `editor` namespace as possibly absent: the jsdom stand-in component tests mount has none
 * (nor change events or actions on its editor), and there an attached editor simply gets no help.
 */
interface LooseMonaco {
  readonly editor?: Partial<typeof Monaco.editor>;
}

function editorApi(monacoNS: typeof Monaco): Partial<typeof Monaco.editor> | undefined {
  return (monacoNS as LooseMonaco).editor;
}
let registered = false;

/** The source attached to `model`, if any. */
function sourceOf(model: Monaco.editor.ITextModel): VariableAssistSource | undefined {
  return sources.get(model.uri.toString());
}

/** Text that cannot break out of a fenced block or a link. */
function fenced(text: string): string {
  return `\`\`\`text\n${text.replace(/```/g, '`​``')}\n\`\`\``;
}

/** A hover's Markdown: name and scope, the value, and the Edit link. */
export function hoverMarkdown(content: HoverContent): { value: string; isTrusted: { enabledCommands: string[] } } {
  const lines = [`**${content.title.replace(/[\\*_`[\]]/g, '\\$&')}** — ${content.scope}`, fenced(content.value)];
  if (content.edit !== undefined) {
    lines.push(
      `[Edit in ${content.scope}](command:${EDIT_VARIABLE_COMMAND}?${encodeURIComponent(JSON.stringify([content.edit]))})`,
    );
  }
  return { value: lines.join('\n\n'), isTrusted: { enabledCommands: [EDIT_VARIABLE_COMMAND] } };
}

/** Registers the providers and the Edit command, once per renderer process. */
export function registerVariableAssistOnce(monacoNS: typeof Monaco): void {
  if (registered) return;
  registered = true;
  editorApi(monacoNS)?.registerCommand?.(EDIT_VARIABLE_COMMAND, (_accessor, target: VariableEditTargetWire) => {
    openVariableEditTarget(target);
  });
  for (const language of LANGUAGES) {
    monacoNS.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['{', '#', ':'],
      provideCompletionItems(model, position) {
        const variables = sourceOf(model)?.variables();
        if (variables === undefined) return { suggestions: [] };
        const line = model.getLineContent(position.lineNumber);
        const context = completionContext(line.slice(0, position.column - 1));
        // A dynamic name is completed by the dynamic values' own provider (#333), in every body editor.
        if (context === undefined || context.kind === 'dynamic') return { suggestions: [] };
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: context.start + 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        };
        const closed = line.charAt(position.column - 1) === '}';
        return {
          suggestions: completionItems(context, variables, closed).map((item, index) => ({
            label: { label: item.label, description: item.detail },
            kind: monacoNS.languages.CompletionItemKind.Variable,
            insertText: item.insertText,
            detail: item.detail,
            // Chain order, not alphabetical: the nearest scope first, as the shorthand resolves.
            sortText: String(index).padStart(4, '0'),
            filterText: item.label,
            range,
            ...(item.documentation !== '' ? { documentation: item.documentation } : {}),
          })),
        };
      },
    });
    monacoNS.languages.registerHoverProvider(language, {
      provideHover(model, position) {
        const source = sourceOf(model);
        if (source === undefined) return null;
        const offset = model.getOffsetAt(position);
        const text = model.getValue();
        const reference = propertyReferences(text).find((ref) => ref.start <= offset && offset < ref.end);
        if (reference === undefined) return null;
        const content = hoverContent(
          classifyReference(reference, source.variables()),
          text.slice(reference.start, reference.end),
        );
        if (content === undefined) return null;
        const start = model.getPositionAt(reference.start);
        const end = model.getPositionAt(reference.end);
        return {
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
          contents: [hoverMarkdown(content)],
        };
      },
    });
  }
}

/** Monaco's `MarkerSeverity.Warning`. */
const WARNING = 4;

/** The unresolved-variable markers for `model`'s text. */
export function variableMarkers(
  model: Pick<Monaco.editor.ITextModel, 'getValue' | 'getPositionAt'>,
  variables: RequestVariables | undefined,
): Monaco.editor.IMarkerData[] {
  return unresolvedReferences(model.getValue(), variables).map((reference) => {
    const start = model.getPositionAt(reference.start);
    const end = model.getPositionAt(reference.end);
    return {
      severity: WARNING,
      message:
        reference.form === 'malformed'
          ? 'This variable reference is not closed with "}".'
          : `Unresolved variable "${reference.name}"`,
      source: 'variables',
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    };
  });
}

/** What {@link attachVariableAssist} hands back. */
export interface VariableAssistHandle {
  /** Re-marks the text: call when the request's variables change. */
  readonly refresh: () => void;
  /** Detaches the editor: no more help, and its marks cleared. */
  readonly dispose: () => void;
}

/** How long typing settles before the marks are recomputed. */
const MARK_DELAY_MS = 250;

/**
 * Gives `editor` variable help backed by `source`: completion and hover, the unresolved marks
 * (recomputed as the text changes), and **Set as Variable…** in its context menu.
 */
export function attachVariableAssist(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monacoNS: typeof Monaco,
  source: VariableAssistSource,
  options: { readonly readOnly?: boolean } = {},
): VariableAssistHandle {
  registerVariableAssistOnce(monacoNS);
  const model = editor.getModel();
  // A model-less editor, or the jsdom stand-in (no change events, actions or markers), gets nothing.
  if (model === null || typeof (editor as Partial<typeof editor>).onDidChangeModelContent !== 'function') {
    return { refresh: () => undefined, dispose: () => undefined };
  }
  const uri = model.uri.toString();
  sources.set(uri, source);

  const mark = (): void => {
    if (model.isDisposed()) return;
    editorApi(monacoNS)?.setModelMarkers?.(model, VARIABLE_MARKER_OWNER, variableMarkers(model, source.variables()));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changes = editor.onDidChangeModelContent(() => {
    clearTimeout(timer);
    timer = setTimeout(mark, MARK_DELAY_MS);
  });
  mark();

  const action =
    source.onSetAsVariable === undefined
      ? undefined
      : editor.addAction({
          id: 'wirebench.setAsVariable',
          label: 'Set as Variable…',
          contextMenuGroupId: '9_cutcopypaste',
          contextMenuOrder: 10,
          precondition: 'editorHasSelection',
          run: (target) => {
            const selection = target.getSelection();
            const selected = selection === null ? '' : (target.getModel()?.getValueInRange(selection) ?? '');
            if (selection === null || selected === '') return;
            source.onSetAsVariable?.(
              selected,
              options.readOnly === true
                ? undefined
                : (reference) => {
                    target.executeEdits('variables', [{ range: selection, text: reference, forceMoveMarkers: true }]);
                  },
            );
          },
        });

  return {
    refresh: mark,
    dispose: () => {
      clearTimeout(timer);
      changes.dispose();
      action?.dispose();
      if (sources.get(uri) === source) sources.delete(uri);
      if (!model.isDisposed()) editorApi(monacoNS)?.setModelMarkers?.(model, VARIABLE_MARKER_OWNER, []);
    },
  };
}
