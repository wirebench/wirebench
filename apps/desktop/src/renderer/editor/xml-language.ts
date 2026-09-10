import { completionContextAt, formatXml } from '@wirebench/engine/xml';
import type * as Monaco from 'monaco-editor';
import { XML_LANGUAGE_ID } from './monaco.js';

/** One candidate child element, as returned by the `xml.completions` IPC channel. */
export interface XmlCompletionCandidate {
  readonly name: string;
  readonly namespaceUri: string;
  readonly documentation?: string;
}

/** What the completion provider needs injected: the IPC call and the interface id in scope. */
export interface XmlCompletionSource {
  readonly interfaceId: string;
  fetchCompletions(args: { readonly path: readonly string[]; readonly partial: string }): Promise<{
    readonly items: readonly XmlCompletionCandidate[];
  }>;
}

/** A single-edit replacement of a document's entire text, for the format provider. */
export interface FormatEdit {
  readonly text: string;
}

/**
 * Computes the format edit for `text`, or `undefined` when formatting would not change
 * anything or the document could not be safely reformatted (unbalanced tags).
 */
export function computeFormatEdit(text: string, indentWidth?: number): FormatEdit | undefined {
  const result = formatXml(text, indentWidth === undefined ? {} : { indent: ' '.repeat(indentWidth) });
  if (result.problem !== undefined || !result.changed) {
    return undefined;
  }
  return { text: result.text };
}

/** Renders a QName as Clark notation, matching the main-process wire format. */
function toClark(namespaceUri: string, localName: string): string {
  return `{${namespaceUri}}${localName}`;
}

/** The `xmlns:prefix="uri"` declarations found on a document's root open tag. */
const ROOT_OPEN_TAG_RE = /^<([^\s/!?>][^\s/>]*)((?:\s+[^<>]*)?)\s*(\/?)>/;

/** Picks the next unused `nsN` prefix (`ns1`, `ns2`, …) given the prefixes already bound. */
export function nextUnusedNsPrefix(boundPrefixes: ReadonlySet<string>): string {
  let n = 1;
  while (boundPrefixes.has(`ns${n}`)) {
    n += 1;
  }
  return `ns${n}`;
}

/** The offset just before the root element's closing `>` (or `/>`), where a new attribute can be inserted. */
function rootTagInsertionPoint(text: string): { readonly offset: number; readonly selfClosing: boolean } | undefined {
  const match = ROOT_OPEN_TAG_RE.exec(text.trimStart());
  if (match === null) {
    return undefined;
  }
  const leadingWs = text.length - text.trimStart().length;
  const selfClosing = match[3] === '/';
  const tagLength = match[0].length;
  const closeLength = selfClosing ? 2 : 1;
  return { offset: leadingWs + tagLength - closeLength, selfClosing };
}

/** A Monaco-shaped completion item plus, when a namespace prefix had to be synthesised, the extra root edit. */
export interface BuiltCompletionItem {
  readonly label: string;
  readonly insertText: string;
  readonly namespaceUri: string;
  readonly documentation?: string;
  /** Set when the item's namespace has no bound prefix in the document: the `xmlns:nsN` text to splice into the root tag. */
  readonly rootEdit?: { readonly offset: number; readonly text: string };
}

/**
 * Builds insertable completion items for `candidates`. Reuses whatever prefix is already
 * bound to a candidate's namespace in the document; when none is bound, synthesises the next
 * unused `nsN` prefix and returns a `rootEdit` that adds `xmlns:nsN="…"` to the root element.
 */
export function buildCompletionItems(
  candidates: readonly XmlCompletionCandidate[],
  documentText: string,
  prefixes: Readonly<Record<string, string>>,
): BuiltCompletionItem[] {
  const uriToPrefix = new Map<string, string>();
  for (const [prefix, uri] of Object.entries(prefixes)) {
    if (prefix !== '' && !uriToPrefix.has(uri)) {
      uriToPrefix.set(uri, prefix);
    }
  }
  const boundPrefixes = new Set(Object.keys(prefixes).filter((p) => p !== ''));
  const insertionPoint = rootTagInsertionPoint(documentText);
  const synthesised = new Map<string, string>();

  return candidates.map((candidate) => {
    let prefix = uriToPrefix.get(candidate.namespaceUri);
    let rootEdit: BuiltCompletionItem['rootEdit'];
    if (prefix === undefined) {
      prefix = synthesised.get(candidate.namespaceUri);
      if (prefix === undefined) {
        prefix = nextUnusedNsPrefix(boundPrefixes);
        boundPrefixes.add(prefix);
        synthesised.set(candidate.namespaceUri, prefix);
        if (insertionPoint !== undefined) {
          rootEdit = { offset: insertionPoint.offset, text: ` xmlns:${prefix}="${candidate.namespaceUri}"` };
        }
      }
    }
    const tagName = `${prefix}:${candidate.name}`;
    return {
      label: tagName,
      insertText: `${tagName}>$0</${tagName}>`,
      namespaceUri: candidate.namespaceUri,
      ...(candidate.documentation !== undefined ? { documentation: candidate.documentation } : {}),
      ...(rootEdit !== undefined ? { rootEdit } : {}),
    };
  });
}

/** Path segments (Clark-notation QName strings) for the completion IPC call, from the engine's pure ancestor path. */
export function pathToWire(path: readonly { readonly namespaceUri: string; readonly localName: string }[]): string[] {
  return path.map((q) => toClark(q.namespaceUri, q.localName));
}

/**
 * Registers Monaco's document-formatting and completion providers for the XML language,
 * backed by the engine's pure `formatXml`/`completionContextAt` and the `xml.completions` IPC
 * channel. Call once per Monaco instance (idempotent per `monaco` singleton is the caller's
 * responsibility, matching `configureMonaco`).
 */
export function registerXmlLanguageFeatures(
  monacoNS: typeof Monaco,
  source: () => XmlCompletionSource | undefined,
): {
  readonly dispose: () => void;
} {
  const formatDisposable = monacoNS.languages.registerDocumentFormattingEditProvider(XML_LANGUAGE_ID, {
    provideDocumentFormattingEdits(model, options) {
      // Monaco hands the model's own tab size in, which the editor already takes from the
      // user's `editor.tabSize` preference — so "Format Document" and the palette's Format XML
      // agree without this module reaching into a store.
      const edit = computeFormatEdit(model.getValue(), options.tabSize);
      if (edit === undefined) {
        return [];
      }
      return [{ range: model.getFullModelRange(), text: edit.text }];
    },
  });

  const completionDisposable = monacoNS.languages.registerCompletionItemProvider(XML_LANGUAGE_ID, {
    triggerCharacters: ['<'],
    async provideCompletionItems(model, position) {
      const completionSource = source();
      if (completionSource === undefined) {
        return { suggestions: [] };
      }
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const ctx = completionContextAt(text, offset);
      if (ctx === undefined) {
        return { suggestions: [] };
      }
      const { items } = await completionSource.fetchCompletions({
        path: pathToWire(ctx.path),
        partial: ctx.partial,
      });
      const built = buildCompletionItems(items, text, ctx.prefixes);
      const startPos = model.getPositionAt(ctx.replaceRange.start);
      const endPos = model.getPositionAt(ctx.replaceRange.end);
      const replaceRange = {
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
      };
      return {
        suggestions: built.map((item) => ({
          label: item.label,
          kind: monacoNS.languages.CompletionItemKind.Property,
          insertText: item.insertText,
          insertTextRules: monacoNS.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range: replaceRange,
          ...(item.documentation !== undefined ? { documentation: item.documentation } : {}),
          ...(item.rootEdit !== undefined
            ? {
                additionalTextEdits: [
                  {
                    range: (() => {
                      const p = model.getPositionAt(item.rootEdit.offset);
                      return {
                        startLineNumber: p.lineNumber,
                        startColumn: p.column,
                        endLineNumber: p.lineNumber,
                        endColumn: p.column,
                      };
                    })(),
                    text: item.rootEdit.text,
                  },
                ],
              }
            : {}),
        })),
      };
    },
  });

  return {
    dispose: () => {
      formatDisposable.dispose();
      completionDisposable.dispose();
    },
  };
}

let languageFeaturesRegistered = false;

/**
 * Registers `registerXmlLanguageFeatures` exactly once per renderer process — Monaco's
 * per-language providers are process-global, so registering twice would offer every
 * completion item twice. Safe to call from every editor instance's mount handler.
 */
export function registerXmlLanguageFeaturesOnce(
  monacoNS: typeof Monaco,
  source: () => XmlCompletionSource | undefined,
): void {
  if (languageFeaturesRegistered) {
    return;
  }
  languageFeaturesRegistered = true;
  registerXmlLanguageFeatures(monacoNS, source);
}

/** Formats `editor`'s current content in place via `executeEdits`, preserving the cursor position. */
export function formatEditorInPlace(editor: Monaco.editor.IStandaloneCodeEditor, indentWidth?: number): void {
  const model = editor.getModel();
  if (model === null) {
    return;
  }
  const edit = computeFormatEdit(model.getValue(), indentWidth);
  if (edit === undefined) {
    return;
  }
  const position = editor.getPosition();
  editor.executeEdits('editor.formatXml', [{ range: model.getFullModelRange(), text: edit.text }]);
  if (position !== null) {
    editor.setPosition(position);
  }
}

/**
 * Pretty-prints `text` via the engine's `formatXml`, always returning a string (the input
 * itself when formatting made no change or the markup could not be safely reformatted). The
 * simple string-in/string-out shape the response pane, history view, and diff view all want.
 */
export function prettyPrintXml(text: string, indentWidth?: number): string {
  return formatXml(text, indentWidth === undefined ? {} : { indent: ' '.repeat(indentWidth) }).text;
}

/** Runs Monaco's built-in "go to line" action. */
export function gotoLine(editor: Monaco.editor.IStandaloneCodeEditor): void {
  void editor.getAction('editor.action.gotoLine')?.run();
}
