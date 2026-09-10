import type * as Monaco from 'monaco-editor';

/**
 * Monaco themes built from `styles/tokens.css`.
 *
 * Monaco cannot read CSS custom properties — `defineTheme` wants literal hex — so the token
 * values are mirrored here. This is the only place in the renderer allowed to repeat a token's
 * hex value; keep it in sync with `tokens.css` when the palette changes (Task 48).
 */

/** The hex values this module mirrors out of `tokens.css`, per theme. */
interface Palette {
  readonly bgBase: string;
  readonly bgRaised: string;
  readonly bgSelected: string;
  readonly fgDefault: string;
  readonly fgMuted: string;
  readonly fgSubtle: string;
  readonly fgFaint: string;
  readonly borderDefault: string;
  readonly accent: string;
  readonly info: string;
  readonly success: string;
  readonly warning: string;
}

const DARK: Palette = {
  bgBase: '#151413',
  bgRaised: '#1c1b19',
  bgSelected: '#3a2a22',
  fgDefault: '#ece9e3',
  fgMuted: '#a49d93',
  fgSubtle: '#756e66',
  fgFaint: '#4c4741',
  borderDefault: '#2a2724',
  accent: '#d97757',
  info: '#7fa6dd',
  success: '#6fbf8f',
  warning: '#d9a441',
};

const LIGHT: Palette = {
  bgBase: '#faf9f7',
  bgRaised: '#ffffff',
  bgSelected: '#f6e3da',
  fgDefault: '#22201d',
  fgMuted: '#5c564e',
  fgSubtle: '#837c73',
  fgFaint: '#b3ada4',
  borderDefault: '#e0dcd5',
  accent: '#bf5730',
  info: '#3d6ba8',
  success: '#2f7d52',
  warning: '#9a6b12',
};

/** Registered theme names, matching `ui.theme`'s resolved values. */
export const MONACO_THEMES = { dark: 'wirebench-dark', light: 'wirebench-light' } as const;

function buildTheme(base: 'vs' | 'vs-dark', palette: Palette): Monaco.editor.IStandaloneThemeData {
  return {
    base,
    inherit: true,
    rules: [
      { token: '', foreground: palette.fgDefault },
      { token: 'tag', foreground: palette.accent },
      { token: 'tag.xml', foreground: palette.accent },
      { token: 'metatag', foreground: palette.fgSubtle },
      { token: 'metatag.content.xml', foreground: palette.fgMuted },
      { token: 'metatag.xml', foreground: palette.fgSubtle },
      { token: 'delimiter', foreground: palette.fgFaint },
      { token: 'attribute.name', foreground: palette.info },
      { token: 'attribute.name.xml', foreground: palette.info },
      { token: 'attribute.value', foreground: palette.success },
      { token: 'attribute.value.xml', foreground: palette.success },
      { token: 'comment', foreground: palette.fgSubtle, fontStyle: 'italic' },
      { token: 'comment.xml', foreground: palette.fgSubtle, fontStyle: 'italic' },
      { token: 'string', foreground: palette.success },
      { token: 'number', foreground: palette.warning },
    ].map((rule) => ({ ...rule, foreground: rule.foreground.replace('#', '') })),
    colors: {
      'editor.background': palette.bgBase,
      'editor.foreground': palette.fgDefault,
      'editorLineNumber.foreground': palette.fgFaint,
      'editorLineNumber.activeForeground': palette.fgMuted,
      'editorGutter.background': palette.bgBase,
      'editor.lineHighlightBackground': palette.bgRaised,
      'editor.selectionBackground': palette.bgSelected,
      'editorCursor.foreground': palette.accent,
      'editorWidget.background': palette.bgRaised,
      'editorWidget.border': palette.borderDefault,
      'editorIndentGuide.background1': palette.borderDefault,
      'scrollbarSlider.background': `${palette.borderDefault}aa`,
      'scrollbarSlider.hoverBackground': palette.borderDefault,
    },
  };
}

/** The two theme definitions, keyed by the name they are registered under. */
export const THEME_DEFINITIONS: Readonly<Record<string, Monaco.editor.IStandaloneThemeData>> = {
  [MONACO_THEMES.dark]: buildTheme('vs-dark', DARK),
  [MONACO_THEMES.light]: buildTheme('vs', LIGHT),
};
