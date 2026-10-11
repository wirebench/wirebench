/**
 * Completion for the Dynamic scope (#333): typing `${$` (or `${#Dynamic#`) in a body editor lists the
 * generators, so nobody has to remember their names. The catalogue is the engine's own, re-exported by
 * the browser-safe `@wirebench/engine/rest` entry.
 */
import type * as Monaco from 'monaco-editor/editor/editor.api.js';
import { DYNAMIC_GENERATORS } from '@wirebench/engine/rest';
import { JSON_LANGUAGE_ID } from './json-language.js';

/** Where a dynamic name being typed starts, and what of it is typed so far. */
export interface DynamicCompletionContext {
  readonly prefix: string;
  /** Offset into the text given of the name's first character. */
  readonly start: number;
}

/** `${$name` or `${#Dynamic#name` at the very end, not behind the `$${` escape. */
const OPEN_REFERENCE = /(?<!\$)\$\{(?:\$|#Dynamic#)([A-Za-z0-9]*)$/;

/** The completion context when `before` (the text up to the caret) ends inside a dynamic name. */
export function dynamicCompletionContext(before: string): DynamicCompletionContext | undefined {
  const match = OPEN_REFERENCE.exec(before);
  if (match === null) return undefined;
  const prefix = match[1]!;
  return { prefix, start: before.length - prefix.length };
}

/** One completion item, Monaco-free so it can be tested on its own. */
export interface DynamicCompletionItem {
  readonly label: string;
  readonly insertText: string;
  readonly detail: string;
  readonly documentation: string;
}

/** Every generator as a completion item; `closed` when a `}` already follows the caret. */
export function buildDynamicCompletionItems(closed: boolean): DynamicCompletionItem[] {
  return DYNAMIC_GENERATORS.map((generator) => ({
    label: generator.name,
    insertText: closed ? generator.name : `${generator.name}}`,
    detail: generator.description,
    documentation: [
      generator.usage !== undefined ? `Arguments: \`(${generator.usage})\`` : undefined,
      generator.aliases.length > 0 ? `Also: ${generator.aliases.map((alias) => `\`${alias}\``).join(', ')}` : undefined,
    ]
      .filter((line) => line !== undefined)
      .join('\n\n'),
  }));
}

/** The languages a request body is edited in. */
const LANGUAGES = ['xml', JSON_LANGUAGE_ID, 'plaintext'];

let registered = false;

/** Registers the provider once per renderer process; Monaco's providers are process-global. */
export function registerDynamicCompletionOnce(monacoNS: typeof Monaco): void {
  if (registered) return;
  registered = true;
  for (const language of LANGUAGES) {
    monacoNS.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['$', '#'],
      provideCompletionItems(model, position) {
        const line = model.getLineContent(position.lineNumber);
        const context = dynamicCompletionContext(line.slice(0, position.column - 1));
        if (context === undefined) return { suggestions: [] };
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: context.start + 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        };
        const closed = line.charAt(position.column - 1) === '}';
        return {
          suggestions: buildDynamicCompletionItems(closed).map((item) => ({
            label: item.label,
            kind: monacoNS.languages.CompletionItemKind.Variable,
            insertText: item.insertText,
            detail: item.detail,
            range,
            ...(item.documentation !== '' ? { documentation: { value: item.documentation } } : {}),
          })),
        };
      },
    });
  }
}
