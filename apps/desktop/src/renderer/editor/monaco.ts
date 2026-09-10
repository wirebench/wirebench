import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// Vite emits this as its own chunk and hands back a `Worker` subclass, so the worker is loaded
// from the app's own origin (`default-src 'self'`) instead of the CDN `loader` Monaco defaults
// to — that default would be blocked by the CSP and is the reason `loader.config` runs here.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { MONACO_THEMES, THEME_DEFINITIONS } from './themes.js';

export { MONACO_THEMES } from './themes.js';

/** The Monaco language id every Wirebench editor uses. */
export const XML_LANGUAGE_ID = 'xml';

let configured = false;

/**
 * Points `@monaco-editor/react` at the bundled `monaco-editor` and registers the Wirebench
 * themes. Idempotent, and safe to call from more than one editor instance.
 *
 * XML has no language worker in Monaco — it is a pure tokenizer — so every label resolves to
 * the base editor worker, which is all the editor itself needs (diffing, link detection).
 */
export function configureMonaco(): typeof monaco {
  if (configured) {
    return monaco;
  }
  configured = true;

  // `MonacoEnvironment` is declared globally by `monaco-editor`'s own type definitions.
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

  loader.config({ monaco });
  for (const [name, definition] of Object.entries(THEME_DEFINITIONS)) {
    monaco.editor.defineTheme(name, definition);
  }

  return monaco;
}

/** The registered Monaco theme name for a resolved app theme. */
export function monacoThemeName(theme: 'dark' | 'light'): string {
  return MONACO_THEMES[theme];
}

/**
 * Monaco's numeric encoding of ⌘⏎ / Ctrl+⏎. Exported so the request pane can register the
 * binding without importing `monaco-editor` itself — that keeps the pane testable under jsdom.
 */
export const SEND_KEYBINDING = monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter;

/** Editor options shared by the request and response panes; per-pane overrides sit alongside. */
export const BASE_EDITOR_OPTIONS = {
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  fontSize: 12,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  tabSize: 3,
  wordWrap: 'on',
  renderLineHighlight: 'none',
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
} as const;
