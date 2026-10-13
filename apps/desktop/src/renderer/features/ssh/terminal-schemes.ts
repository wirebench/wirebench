/**
 * The terminal's built-in colour schemes: plain data, no zod, so any terminal (SSH or local) can import
 * it. `app` is not a palette here: it follows the app's light or dark tokens (`terminal-theme.ts`).
 */

/** The 16 ANSI colours, normal then bright, in xterm's order. */
type Ansi = readonly [
  black: string,
  red: string,
  green: string,
  yellow: string,
  blue: string,
  magenta: string,
  cyan: string,
  white: string,
  brightBlack: string,
  brightRed: string,
  brightGreen: string,
  brightYellow: string,
  brightBlue: string,
  brightMagenta: string,
  brightCyan: string,
  brightWhite: string,
];

export interface TerminalScheme {
  readonly id: string;
  readonly label: string;
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly selection: string;
  readonly ansi: Ansi;
}

/** The id that follows the app theme, and the default. */
export const APP_SCHEME_ID = 'app';

const SOLARIZED: Ansi = [
  '#073642',
  '#dc322f',
  '#859900',
  '#b58900',
  '#268bd2',
  '#d33682',
  '#2aa198',
  '#eee8d5',
  '#002b36',
  '#cb4b16',
  '#586e75',
  '#657b83',
  '#839496',
  '#6c71c4',
  '#93a1a1',
  '#fdf6e3',
];

const TOMORROW_NIGHT: Ansi = [
  '#1d1f21',
  '#cc6666',
  '#b5bd68',
  '#f0c674',
  '#81a2be',
  '#b294bb',
  '#8abeb7',
  '#c5c8c6',
  '#969896',
  '#d54e53',
  '#b9ca4a',
  '#e7c547',
  '#7aa6da',
  '#c397d8',
  '#70c0b1',
  '#ffffff',
];

/** A dark scheme whose background carries a cue (production red, staging amber); the ANSI colours stay readable. */
function tint(id: string, label: string, background: string, foreground: string, selection: string): TerminalScheme {
  return { id, label, background, foreground, cursor: foreground, selection, ansi: TOMORROW_NIGHT };
}

export const TERMINAL_SCHEMES: readonly TerminalScheme[] = [
  tint('red', 'Red background', '#2b1215', '#f2dcdc', '#5a2a2f'),
  tint('amber', 'Amber background', '#2a2010', '#f3e7cf', '#5a4524'),
  tint('green', 'Green background', '#10241a', '#dcefe2', '#25503a'),
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    selection: '#073642',
    ansi: SOLARIZED,
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#586e75',
    selection: '#eee8d5',
    ansi: SOLARIZED,
  },
  {
    id: 'dracula',
    label: 'Dracula',
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selection: '#44475a',
    ansi: [
      '#21222c',
      '#ff5555',
      '#50fa7b',
      '#f1fa8c',
      '#bd93f9',
      '#ff79c6',
      '#8be9fd',
      '#f8f8f2',
      '#6272a4',
      '#ff6e6e',
      '#69ff94',
      '#ffffa5',
      '#d6acff',
      '#ff92df',
      '#a4ffff',
      '#ffffff',
    ],
  },
  {
    id: 'nord',
    label: 'Nord',
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selection: '#434c5e',
    ansi: [
      '#3b4252',
      '#bf616a',
      '#a3be8c',
      '#ebcb8b',
      '#81a1c1',
      '#b48ead',
      '#88c0d0',
      '#e5e9f0',
      '#4c566a',
      '#bf616a',
      '#a3be8c',
      '#ebcb8b',
      '#81a1c1',
      '#b48ead',
      '#8fbcbb',
      '#eceff4',
    ],
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    selection: '#504945',
    ansi: [
      '#282828',
      '#cc241d',
      '#98971a',
      '#d79921',
      '#458588',
      '#b16286',
      '#689d6a',
      '#a89984',
      '#928374',
      '#fb4934',
      '#b8bb26',
      '#fabd2f',
      '#83a598',
      '#d3869b',
      '#8ec07c',
      '#ebdbb2',
    ],
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    selection: '#3e4451',
    ansi: [
      '#282c34',
      '#e06c75',
      '#98c379',
      '#e5c07b',
      '#61afef',
      '#c678dd',
      '#56b6c2',
      '#abb2bf',
      '#5c6370',
      '#e06c75',
      '#98c379',
      '#e5c07b',
      '#61afef',
      '#c678dd',
      '#56b6c2',
      '#ffffff',
    ],
  },
  {
    id: 'tomorrow-night',
    label: 'Tomorrow Night',
    background: '#1d1f21',
    foreground: '#c5c8c6',
    cursor: '#c5c8c6',
    selection: '#373b41',
    ansi: TOMORROW_NIGHT,
  },
];

/** A built-in palette by id; `undefined` for `app` and for an id this version does not know. */
export function schemeById(id: string | undefined): TerminalScheme | undefined {
  return TERMINAL_SCHEMES.find((scheme) => scheme.id === id);
}

/** What a scheme id reads as in a list or the host details: its label, or the id itself when unknown. */
export function schemeLabel(id: string): string {
  return id === APP_SCHEME_ID ? 'Follow app theme' : (schemeById(id)?.label ?? id);
}
