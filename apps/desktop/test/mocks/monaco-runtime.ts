/**
 * Stands in for `renderer/editor/monaco.ts` under jsdom. Importing the real module pulls in
 * the whole `monaco-editor` bundle and a `?worker` import Vitest cannot resolve, and none of
 * it would run in jsdom anyway — the wrapper's contract is just these four values.
 */

export const XML_LANGUAGE_ID = 'xml';

export const MONACO_THEMES = { dark: 'wirebench-dark', light: 'wirebench-light' } as const;

export function configureMonaco(): undefined {
  return undefined;
}

export function monacoThemeName(theme: 'dark' | 'light'): string {
  return MONACO_THEMES[theme];
}

/** `monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter`, with Monaco's real numeric values. */
export const SEND_KEYBINDING = 2048 | 3;

/** `monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF`. */
export const FORMAT_KEYBINDING = 2048 | 1024 | 36;

/** `monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG`. */
export const GOTO_LINE_KEYBINDING = 2048 | 37;

/** `monaco.KeyCode.F12`. */
export const GOTO_DEFINITION_KEYBINDING = 70;

/** `monaco.KeyMod.Alt | monaco.KeyCode.RightArrow`. */
export const NEXT_VALUE_KEYBINDING = 512 | 17;

/** `monaco.KeyMod.Alt | monaco.KeyCode.LeftArrow`. */
export const PREVIOUS_VALUE_KEYBINDING = 512 | 15;

/** `monaco.KeyMod.Shift | monaco.KeyCode.Tab`. */
export const FOCUS_OTHER_PANE_KEYBINDING = 1024 | 2;

export const BASE_EDITOR_OPTIONS = { tabSize: 3, wordWrap: 'on' } as const;
