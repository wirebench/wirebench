import { loader } from '@monaco-editor/react';
// Not `monaco-editor` itself: that entry registers every bundled language and the TS/CSS/HTML/
// JSON language services, whose four web workers dominated the renderer's build output. See
// `monaco-core.ts` for the trimmed set: the editor features, plus XML and the built-in plaintext
// fallback — no JSON, which in monaco-editor 0.56 exists only as a worker-backed language service.
import { monaco } from './monaco-core.js';
// Vite emits this as its own chunk and hands back a `Worker` subclass, so the worker is loaded
// from the app's own origin (`default-src 'self'`) instead of the CDN `loader` Monaco defaults
// to — that default would be blocked by the CSP and is the reason `loader.config` runs here.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { MONACO_THEMES, THEME_DEFINITIONS } from './themes.js';
import { registerJsonLanguage } from './json-language.js';

export { MONACO_THEMES } from './themes.js';

/** The Monaco language id every Wirebench editor uses. */
export const XML_LANGUAGE_ID = 'xml';

let configured = false;

/**
 * Points `@monaco-editor/react` at the bundled `monaco-editor` and registers the Wirebench
 * themes. Idempotent, and safe to call from more than one editor instance.
 *
 * XML has no language worker in Monaco — it is a pure tokenizer — so every label resolves to
 * the base editor worker, which is all the editor itself needs (diffing, link detection), and
 * it is the only worker `monaco-core.ts` leaves reachable.
 */
export function configureMonaco(): typeof monaco {
  if (configured) {
    return monaco;
  }
  configured = true;

  // `MonacoEnvironment` is declared globally by `monaco-editor`'s own type definitions.
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

  // JSON is registered here rather than by the editor component: this function is the one place
  // that owns Monaco's global setup, and doing it before `loader.config` means no editor can mount
  // against a Monaco that has the language missing.
  registerJsonLanguage(monaco);

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

/** Monaco's numeric encoding of ⌘S / Ctrl+S: `item.save`. */
export const SAVE_KEYBINDING = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS;

/** Monaco's numeric encoding of ⌘⇧F / Ctrl+Shift+F: `editor.formatXml`. */
export const FORMAT_KEYBINDING = monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF;

/** Monaco's numeric encoding of ⌘G / Ctrl+G: `editor.gotoLine`. */
export const GOTO_LINE_KEYBINDING = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG;

/** Monaco's numeric encoding of F12: "Go to Schema Definition". */
export const GOTO_DEFINITION_KEYBINDING = monaco.KeyCode.F12;

/**
 * ⌥→ / ⌥← ("next/previous element value") and ⇧⇥ ("focus the other pane").
 *
 * Unlike the Mod-based chords above, Monaco binds all three itself (word-wise caret motion and
 * outdent), and its keybinding service consumes a keystroke it has a binding for before the
 * window-level dispatcher can see it. So these have to be registered on the editor as well, or
 * the design's element-value moves would only work with focus outside the editor.
 */
export const NEXT_VALUE_KEYBINDING = monaco.KeyMod.Alt | monaco.KeyCode.RightArrow;
export const PREVIOUS_VALUE_KEYBINDING = monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow;
export const FOCUS_OTHER_PANE_KEYBINDING = monaco.KeyMod.Shift | monaco.KeyCode.Tab;

/** Editor options shared by the request and response panes; per-pane overrides sit alongside. */
export const BASE_EDITOR_OPTIONS = {
  automaticLayout: true,
  // `auto` lets Monaco switch itself into its screen-reader-friendly DOM when it detects an
  // assistive technology, instead of always rendering the fast-but-opaque canvas-ish view.
  accessibilitySupport: 'auto',
  fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  tabSize: 3,
  wordWrap: 'off',
  renderLineHighlight: 'none',
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
} as const;
