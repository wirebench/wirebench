/**
 * A request script's language features (#63): completion, hover, signature help and diagnostics,
 * all answered by main's checker against the request's own types.
 *
 * The renderer keeps no TypeScript service — that would bring `ts.worker` back and break the
 * renderer's budget. Monaco only tokenises (`monaco-core.ts` registers the grammars); the providers
 * here are registered once per language and consult a registry keyed by model URI, as the JSON
 * completion does: a script editor registers which request and which script its model holds (or
 * which mock operation's `dispatch.ts`, #352), and every other TypeScript or JavaScript model is
 * left alone.
 */
import type * as Monaco from 'monaco-editor';
import { ipc } from '../state/ipc-client.js';
import type { ScriptDiagnosticWire } from '../../shared/wire-types.js';

export type ScriptPhase = 'pre' | 'post';

/** Which script a model holds: one of a request's two, or a mock operation's dispatch script. */
export type ScriptModelTarget =
  | { readonly requestId: string; readonly phase: ScriptPhase }
  | { readonly mockId: string; readonly operationId: string };

/** The owner Monaco files a script's markers under. */
export const SCRIPT_MARKER_OWNER = 'wirebench-script';

const targets = new Map<string, ScriptModelTarget>();

/** The model path a script editor opens: one model per request and script, named as its file would be. */
export function scriptModelPath(requestId: string, phase: ScriptPhase, api: 'wirebench' | 'postman'): string {
  return `wirebench-script/${encodeURIComponent(requestId)}/${phase}.${api === 'postman' ? 'js' : 'ts'}`;
}

/** The model path a dispatch script editor opens: one model per mock operation. */
export function dispatchScriptModelPath(mockId: string, operationId: string): string {
  return `wirebench-script/${encodeURIComponent(mockId)}/${encodeURIComponent(operationId)}/dispatch.ts`;
}

/** Points the providers at `target` for the model at `modelUri`. */
export function setScriptModelTarget(modelUri: string, target: ScriptModelTarget): void {
  targets.set(modelUri, target);
}

/** Forgets the model at `modelUri`, and tells main its language service can go. */
export function clearScriptModelTarget(modelUri: string): void {
  const target = targets.get(modelUri);
  targets.delete(modelUri);
  if (target !== undefined) {
    void ipc().script.closeModel(target);
  }
}

/** The script a model holds, if it is one. */
export function scriptModelTarget(modelUri: string): ScriptModelTarget | undefined {
  return targets.get(modelUri);
}

/** Monaco's kind for a TypeScript completion kind (`ts.ScriptElementKind`). */
export function completionKindOf(kinds: typeof Monaco.languages.CompletionItemKind, kind: string): number {
  switch (kind) {
    case 'method':
      return kinds.Method;
    case 'function':
    case 'local function':
      return kinds.Function;
    case 'property':
    case 'getter':
    case 'setter':
      return kinds.Property;
    case 'const':
      return kinds.Constant;
    case 'var':
    case 'let':
    case 'local var':
    case 'parameter':
      return kinds.Variable;
    case 'keyword':
      return kinds.Keyword;
    case 'interface':
      return kinds.Interface;
    case 'type':
    case 'alias':
    case 'type parameter':
      return kinds.TypeParameter;
    case 'class':
      return kinds.Class;
    case 'enum':
      return kinds.Enum;
    case 'enum member':
      return kinds.EnumMember;
    case 'module':
      return kinds.Module;
    case 'string':
      return kinds.Value;
    default:
      return kinds.Text;
  }
}

/** A checker diagnostic as a Monaco marker. */
export function toMarker(
  severities: typeof Monaco.MarkerSeverity,
  diagnostic: ScriptDiagnosticWire,
): Monaco.editor.IMarkerData {
  return {
    startLineNumber: diagnostic.line,
    startColumn: diagnostic.column,
    endLineNumber: diagnostic.endLine,
    endColumn: Math.max(diagnostic.endColumn, diagnostic.line === diagnostic.endLine ? diagnostic.column + 1 : 1),
    message: diagnostic.message,
    code: String(diagnostic.code),
    severity: diagnostic.severity === 'error' ? severities.Error : severities.Warning,
  };
}

/**
 * Asks main to check the script in `model` and puts the answer on it as markers. A reply for text
 * the model no longer holds is dropped: a later check is already on its way.
 */
export async function refreshScriptDiagnostics(
  monacoNS: typeof Monaco,
  model: Monaco.editor.ITextModel,
): Promise<readonly ScriptDiagnosticWire[]> {
  const target = targets.get(model.uri.toString());
  if (target === undefined) {
    return [];
  }
  const version = model.getVersionId();
  const result = await ipc().script.diagnostics({ ...target, source: model.getValue() });
  if (!result.ok || model.isDisposed() || model.getVersionId() !== version) {
    return [];
  }
  // The jsdom test double for Monaco carries no `editor` namespace; there is nothing to mark then.
  if (typeof (monacoNS as Partial<typeof Monaco>).editor?.setModelMarkers === 'function') {
    const markers = result.value.diagnostics.map((diagnostic) => toMarker(monacoNS.MarkerSeverity, diagnostic));
    monacoNS.editor.setModelMarkers(model, SCRIPT_MARKER_OWNER, markers);
  }
  return result.value.diagnostics;
}

let registered = false;

/**
 * Registers the script providers once per renderer process, for TypeScript and JavaScript: Monaco's
 * providers are process-global, so a second registration would answer everything twice.
 */
export function registerScriptLanguageOnce(monacoNS: typeof Monaco): void {
  if (registered) {
    return;
  }
  registered = true;
  for (const language of ['typescript', 'javascript']) {
    monacoNS.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.'],
      async provideCompletionItems(model, position) {
        const target = targets.get(model.uri.toString());
        if (target === undefined) {
          return { suggestions: [] };
        }
        const result = await ipc().script.completions({
          ...target,
          source: model.getValue(),
          line: position.lineNumber,
          column: position.column,
        });
        if (!result.ok) {
          return { suggestions: [] };
        }
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };
        return {
          suggestions: result.value.items.map((item) => ({
            label: item.name,
            kind: completionKindOf(monacoNS.languages.CompletionItemKind, item.kind),
            insertText: item.name,
            range,
            ...(item.detail !== undefined ? { detail: item.detail } : {}),
          })),
        };
      },
    });
    monacoNS.languages.registerHoverProvider(language, {
      async provideHover(model, position) {
        const target = targets.get(model.uri.toString());
        if (target === undefined) {
          return null;
        }
        const result = await ipc().script.quickInfo({
          ...target,
          source: model.getValue(),
          line: position.lineNumber,
          column: position.column,
        });
        const info = result.ok ? result.value.info : undefined;
        if (info === undefined) {
          return null;
        }
        return {
          contents: [
            { value: `\`\`\`typescript\n${info.text}\n\`\`\`` },
            ...(info.documentation !== undefined && info.documentation !== '' ? [{ value: info.documentation }] : []),
          ],
        };
      },
    });
    monacoNS.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ['(', ','],
      async provideSignatureHelp(model, position) {
        const target = targets.get(model.uri.toString());
        if (target === undefined) {
          return null;
        }
        const result = await ipc().script.signatureHelp({
          ...target,
          source: model.getValue(),
          line: position.lineNumber,
          column: position.column,
        });
        const help = result.ok ? result.value.help : undefined;
        if (help === undefined) {
          return null;
        }
        return {
          value: {
            signatures: [
              {
                label: help.label,
                parameters: help.parameters.map((label) => ({ label })),
                ...(help.documentation !== undefined ? { documentation: help.documentation } : {}),
              },
            ],
            activeSignature: 0,
            activeParameter: help.activeParameter,
          },
          dispose: () => undefined,
        };
      },
    });
  }
}
