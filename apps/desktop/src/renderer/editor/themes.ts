import type * as Monaco from 'monaco-editor';
import { PALETTES, type Palette } from '@shared/palettes.js';

/**
 * Monaco themes built from `styles/tokens.css`, one per colour theme and mode.
 *
 * Monaco cannot read CSS custom properties — `defineTheme` wants literal hex — so the token
 * values are mirrored here. This is the only place in the renderer allowed to repeat a token's
 * hex value; keep it in sync with `tokens.css` when a palette changes (`monaco-themes.test.ts`
 * fails when it is not).
 */

/** The hex values this module mirrors out of `tokens.css`, per colour theme and mode. */
export interface EditorColours {
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

/** A theme's mode, as `ui.theme` resolves it. */
export type EditorMode = 'dark' | 'light';

/**
 * Every colour theme's editor colours, read from that theme's blocks in `tokens.css` as the
 * browser cascades them (a token a palette does not restate is Default's for that mode).
 *
 * Default included: its records once kept older values after the contrast gate moved a few of
 * its tokens, and were brought back in line with `tokens.css` (#803). The test holds every value
 * equal to its token.
 */
export const EDITOR_COLOURS: Readonly<Record<Palette, Readonly<Record<EditorMode, EditorColours>>>> = {
  default: {
    dark: {
      bgBase: '#151413',
      bgRaised: '#1c1b19',
      bgSelected: '#3a2a22',
      fgDefault: '#ece9e3',
      fgMuted: '#a49d93',
      fgSubtle: '#8d8780',
      fgFaint: '#8a847d',
      borderDefault: '#2a2724',
      accent: '#d97757',
      info: '#7fa6dd',
      success: '#6fbf8f',
      warning: '#d9a441',
    },
    light: {
      bgBase: '#faf9f7',
      bgRaised: '#ffffff',
      bgSelected: '#f6e3da',
      fgDefault: '#22201d',
      fgMuted: '#5c564e',
      fgSubtle: '#6d675f',
      fgFaint: '#706a62',
      borderDefault: '#e0dcd5',
      accent: '#a94d2b',
      info: '#3d6ba8',
      success: '#2b7550',
      warning: '#8b6010',
    },
  },
  'field-kit': {
    dark: {
      bgBase: '#2a1c17',
      bgRaised: '#452c24',
      bgSelected: '#5a2c1c',
      fgDefault: '#f1e6dc',
      fgMuted: '#cdb6a4',
      fgSubtle: '#bd9c8e',
      fgFaint: '#9f9992',
      borderDefault: '#4a3329',
      accent: '#e8804f',
      info: '#a9a9d6',
      success: '#6fbf8f',
      warning: '#d9a441',
    },
    light: {
      bgBase: '#f7f0e8',
      bgRaised: '#fffbf7',
      bgSelected: '#f6dcd0',
      fgDefault: '#452c24',
      fgMuted: '#684a36',
      fgSubtle: '#7a5c48',
      fgFaint: '#6c665f',
      borderDefault: '#e2d2c3',
      accent: '#b53d1d',
      info: '#5a5a8d',
      success: '#2a734f',
      warning: '#895e10',
    },
  },
  sandstone: {
    dark: {
      bgBase: '#1c1714',
      bgRaised: '#2a221d',
      bgSelected: '#2e2b45',
      fgDefault: '#efe3d8',
      fgMuted: '#c9b3a2',
      fgSubtle: '#b5947e',
      fgFaint: '#8f8982',
      borderDefault: '#3d322a',
      accent: '#8a8ac4',
      info: '#7fa6dd',
      success: '#6fbf8f',
      warning: '#d9a86a',
    },
    light: {
      bgBase: '#fbf7f3',
      bgRaised: '#ffffff',
      bgSelected: '#e4e4f2',
      fgDefault: '#452c24',
      fgMuted: '#684a36',
      fgSubtle: '#7a5c48',
      fgFaint: '#6c665f',
      borderDefault: '#dcc8b8',
      accent: '#5a5a8d',
      info: '#3a68a2',
      success: '#2a734f',
      warning: '#8e5a14',
    },
  },
  dusk: {
    dark: {
      bgBase: '#1a1820',
      bgRaised: '#24212a',
      bgSelected: '#3a2e26',
      fgDefault: '#ece6e0',
      fgMuted: '#c9bdb2',
      fgSubtle: '#948e87',
      fgFaint: '#8e8881',
      borderDefault: '#34303c',
      accent: '#e06a40',
      info: '#7fa6dd',
      success: '#6fbf8f',
      warning: '#d9a441',
    },
    light: {
      bgBase: '#f7f4f0',
      bgRaised: '#ffffff',
      bgSelected: '#eadfd4',
      fgDefault: '#452c24',
      fgMuted: '#684a36',
      fgSubtle: '#6d675f',
      fgFaint: '#6e6861',
      borderDefault: '#e2d9cf',
      accent: '#b53d1d',
      info: '#3c6aa6',
      success: '#2b7550',
      warning: '#8b6010',
    },
  },
  seed: {
    dark: {
      bgBase: '#1a0d10',
      bgRaised: '#2a1418',
      bgSelected: '#5b121f',
      fgDefault: '#f2e6da',
      fgMuted: '#dcc3a9',
      fgSubtle: '#c9a99a',
      fgFaint: '#8a847d',
      borderDefault: '#461118',
      accent: '#e8506e',
      info: '#7fa6dd',
      success: '#6fbf8f',
      warning: '#d9b441',
    },
    light: {
      bgBase: '#fbf6f1',
      bgRaised: '#ffffff',
      bgSelected: '#ebcfd2',
      fgDefault: '#461118',
      fgMuted: '#5b121f',
      fgSubtle: '#7a3a44',
      fgFaint: '#6d675f',
      borderDefault: '#e5d3c4',
      accent: '#8b1128',
      info: '#3c6aa6',
      success: '#2b7550',
      warning: '#836210',
    },
  },
  pith: {
    dark: {
      bgBase: '#171515',
      bgRaised: '#1f1c1c',
      bgSelected: '#3a1e23',
      fgDefault: '#ece6e1',
      fgMuted: '#c4bab4',
      fgSubtle: '#a39a95',
      fgFaint: '#8a847d',
      borderDefault: '#302b2b',
      accent: '#e8506e',
      info: '#7fa6dd',
      success: '#6fbf8f',
      warning: '#d9b441',
    },
    light: {
      bgBase: '#faf8f5',
      bgRaised: '#ffffff',
      bgSelected: '#f7e4e7',
      fgDefault: '#2b2224',
      fgMuted: '#4a4042',
      fgSubtle: '#6e6466',
      fgFaint: '#706a62',
      borderDefault: '#e6dfd7',
      accent: '#bb1731',
      info: '#3d6ba8',
      success: '#2b7550',
      warning: '#836210',
    },
  },
  rind: {
    dark: {
      bgBase: '#151213',
      bgRaised: '#1e1a1b',
      bgSelected: '#3a1e23',
      fgDefault: '#ece4dd',
      fgMuted: '#c9bdb5',
      fgSubtle: '#8d8780',
      fgFaint: '#8a847d',
      borderDefault: '#2e2829',
      accent: '#e8506e',
      info: '#7fa6dd',
      success: '#6fbf8f',
      warning: '#d9b441',
    },
    light: {
      bgBase: '#fbf8f5',
      bgRaised: '#ffffff',
      bgSelected: '#f2e6da',
      fgDefault: '#2b1a1c',
      fgMuted: '#5b121f',
      fgSubtle: '#6d675f',
      fgFaint: '#706a62',
      borderDefault: '#e8dfd6',
      accent: '#bb1731',
      info: '#3d6ba8',
      success: '#2b7550',
      warning: '#836210',
    },
  },
  plume: {
    dark: {
      bgBase: '#1b1a1f',
      bgRaised: '#232228',
      bgSelected: '#3a3850',
      fgDefault: '#f1f1f4',
      fgMuted: '#c9cddc',
      fgSubtle: '#afb6ce',
      fgFaint: '#9196a8',
      borderDefault: '#34333b',
      accent: '#b48bbb',
      info: '#7fa6dd',
      success: '#6fc0a2',
      warning: '#d9a441',
    },
    light: {
      bgBase: '#f7f7fa',
      bgRaised: '#ffffff',
      bgSelected: '#dde1ee',
      fgDefault: '#2b2425',
      fgMuted: '#4e4a55',
      fgSubtle: '#5e5a66',
      fgFaint: '#6a6874',
      borderDefault: '#dfe1ea',
      accent: '#7a5482',
      info: '#3d6ba8',
      success: '#1f7a5a',
      warning: '#8b6010',
    },
  },
  kiln: {
    dark: {
      bgBase: '#262624',
      bgRaised: '#2d2d2a',
      bgSelected: '#4a3a30',
      fgDefault: '#f0eee6',
      fgMuted: '#c9c6bc',
      fgSubtle: '#aeaba1',
      fgFaint: '#a19e94',
      borderDefault: '#3b3a36',
      accent: '#e08a68',
      info: '#7fa6dd',
      success: '#7fc79a',
      warning: '#d9a441',
    },
    light: {
      bgBase: '#faf9f5',
      bgRaised: '#ffffff',
      bgSelected: '#ece2d4',
      fgDefault: '#141413',
      fgMuted: '#3d3d3a',
      fgSubtle: '#5a5954',
      fgFaint: '#6b6a64',
      borderDefault: '#e3dfd3',
      accent: '#a64b29',
      info: '#3d6ba8',
      success: '#2b7550',
      warning: '#8b6010',
    },
  },
};

/** The registered name for one colour theme in one mode. */
function themeName(palette: Palette, mode: EditorMode): string {
  // Default keeps the names it had before colour themes.
  return palette === 'default' ? `wirebench-${mode}` : `wirebench-${palette}-${mode}`;
}

/**
 * Registered theme names, by colour theme and mode: `wirebench-<palette>-<mode>`, except Default's
 * `wirebench-dark` and `wirebench-light`.
 */
export const MONACO_THEMES: Readonly<Record<Palette, Readonly<Record<EditorMode, string>>>> = Object.fromEntries(
  PALETTES.map((palette) => [palette, { dark: themeName(palette, 'dark'), light: themeName(palette, 'light') }]),
) as Record<Palette, Record<EditorMode, string>>;

/** The registered Monaco theme name for a resolved mode and a colour theme. */
export function monacoThemeName(mode: EditorMode, palette: Palette): string {
  return MONACO_THEMES[palette][mode];
}

function buildTheme(base: 'vs' | 'vs-dark', palette: EditorColours): Monaco.editor.IStandaloneThemeData {
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

/** The eighteen theme definitions, keyed by the name they are registered under. */
export const THEME_DEFINITIONS: Readonly<Record<string, Monaco.editor.IStandaloneThemeData>> = Object.fromEntries(
  PALETTES.flatMap((palette) => [
    [MONACO_THEMES[palette].dark, buildTheme('vs-dark', EDITOR_COLOURS[palette].dark)],
    [MONACO_THEMES[palette].light, buildTheme('vs', EDITOR_COLOURS[palette].light)],
  ]),
);
