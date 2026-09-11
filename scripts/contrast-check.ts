/**
 * WCAG contrast gate for the design tokens.
 *
 * Parses `apps/desktop/src/renderer/styles/tokens.css` for both themes (dark on `:root`, light
 * under `[data-theme='light']`, which inherits every token it does not restate) and checks the
 * foreground/surface pairs the UI actually puts on screen. Text pairs must clear WCAG AA's
 * 4.5:1; borders, icons and other non-text UI must clear 3:1 (WCAG 2.1 SC 1.4.11).
 *
 * `node scripts/contrast-check.ts` prints the table and exits non-zero on any failure;
 * `--table` prints it and always exits 0 (what the task report was generated with). Wired as
 * `pnpm contrast:check`, and into `pnpm check`.
 *
 * The pairs below are listed explicitly rather than derived combinatorially: most
 * foreground/surface combinations never occur, and gating on pairs the UI never renders would
 * make the palette answer for contrast it is not responsible for.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TOKENS = fileURLToPath(new URL('../apps/desktop/src/renderer/styles/tokens.css', import.meta.url));

/** AA for body text; the UI's smallest type is 11px, so the large-text 3:1 exemption never applies. */
const TEXT_MINIMUM = 4.5;
/** SC 1.4.11 for borders, icons and other non-text indicators. */
const UI_MINIMUM = 3;

type Theme = 'dark' | 'light';
type Kind = 'text' | 'ui';

interface Pair {
  /** The `--wb-*` token painted on top. */
  readonly fg: string;
  /** The `--wb-bg-*` token underneath. */
  readonly bg: string;
  /** `text` gates at 4.5:1, `ui` (borders, icons, status dots) at 3:1. */
  readonly kind: Kind;
  /** Where this combination is rendered — why the pair is in the list. */
  readonly where: string;
}

/**
 * Every foreground/surface combination the shell renders, by the component that renders it.
 *
 * `--wb-fg-faint` is in the text list. It does paint inert `·` separators, but it also paints
 * real copy people are meant to read — the palette's group headings and shortcut hints, the
 * "overrides the default" hint under a header, recent-project timestamps, search line numbers,
 * the "None"/"No entries yet" placeholders — so it answers for 4.5:1 like any other text token.
 * The consequence is that it now sits very close to `--wb-fg-subtle`: a foreground quieter than
 * AA allows is not a scale step, it is unreadable text.
 */
const PAIRS: readonly Pair[] = [
  // Body text on every surface it lands on.
  { fg: '--wb-fg-default', bg: '--wb-bg-base', kind: 'text', where: 'editor area, welcome screen' },
  { fg: '--wb-fg-default', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar, activity bar' },
  { fg: '--wb-fg-default', bg: '--wb-bg-raised', kind: 'text', where: 'sidebar, inspectors, dialogs' },
  { fg: '--wb-fg-default', bg: '--wb-bg-overlay', kind: 'text', where: 'command palette, menus' },
  { fg: '--wb-fg-default', bg: '--wb-bg-hover', kind: 'text', where: 'hovered tree/list row' },
  { fg: '--wb-fg-default', bg: '--wb-bg-active', kind: 'text', where: 'pressed row, active tab' },
  { fg: '--wb-fg-default', bg: '--wb-bg-selected', kind: 'text', where: 'selected explorer/history row' },
  { fg: '--wb-fg-default', bg: '--wb-accent-surface', kind: 'text', where: 'accent-tinted callouts' },

  // Secondary copy: section headings, column headers, metadata columns.
  { fg: '--wb-fg-muted', bg: '--wb-bg-base', kind: 'text', where: 'editor-area metadata' },
  { fg: '--wb-fg-muted', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar metadata' },
  { fg: '--wb-fg-muted', bg: '--wb-bg-raised', kind: 'text', where: 'inspector labels, response headers' },
  { fg: '--wb-fg-muted', bg: '--wb-bg-hover', kind: 'text', where: 'hovered tab label' },

  // The quietest text the UI still asks people to read.
  { fg: '--wb-fg-subtle', bg: '--wb-bg-base', kind: 'text', where: 'empty states, hints' },
  { fg: '--wb-fg-subtle', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar, problem counts' },
  { fg: '--wb-fg-subtle', bg: '--wb-bg-raised', kind: 'text', where: 'column headers, tab labels' },
  { fg: '--wb-fg-subtle', bg: '--wb-bg-overlay', kind: 'text', where: 'palette category labels' },

  // The quietest text token of all: hints, placeholders, palette group headings.
  { fg: '--wb-fg-faint', bg: '--wb-bg-base', kind: 'text', where: 'welcome timestamps, editor hints' },
  { fg: '--wb-fg-faint', bg: '--wb-bg-sunken', kind: 'text', where: 'title bar, status bar separators' },
  { fg: '--wb-fg-faint', bg: '--wb-bg-raised', kind: 'text', where: 'inspector hints, form badges' },

  // Accent-on-surface and text on the accent itself.
  { fg: '--wb-accent-default', bg: '--wb-bg-base', kind: 'text', where: 'links, "Set as default"' },
  { fg: '--wb-accent-default', bg: '--wb-bg-raised', kind: 'text', where: 'sidebar links' },
  { fg: '--wb-fg-on-accent', bg: '--wb-accent-default', kind: 'text', where: 'primary buttons' },
  { fg: '--wb-fg-on-accent', bg: '--wb-status-danger', kind: 'text', where: 'destructive buttons, problem badges' },
  { fg: '--wb-fg-on-accent', bg: '--wb-status-warning', kind: 'text', where: 'orphaned-node badge' },

  // Status text: response codes in the status bar, problem rows, keystore chips.
  { fg: '--wb-status-success', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar 2xx' },
  { fg: '--wb-status-success', bg: '--wb-bg-raised', kind: 'text', where: 'keystore "Loaded" chip' },
  { fg: '--wb-status-danger', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar failure' },
  { fg: '--wb-status-danger', bg: '--wb-bg-raised', kind: 'text', where: 'problem rows, error copy' },
  { fg: '--wb-status-warning', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar warning count' },
  { fg: '--wb-status-warning', bg: '--wb-bg-raised', kind: 'text', where: 'warning rows, required marks' },
  { fg: '--wb-status-info', bg: '--wb-bg-raised', kind: 'text', where: 'informational copy' },

  // Non-text: hairlines, the focus ring, and the severity icons.
  { fg: '--wb-border-strong', bg: '--wb-bg-base', kind: 'ui', where: 'input borders' },
  { fg: '--wb-border-strong', bg: '--wb-bg-raised', kind: 'ui', where: 'input borders on panels' },
  { fg: '--wb-border-focus', bg: '--wb-bg-base', kind: 'ui', where: 'focus ring' },
  { fg: '--wb-border-focus', bg: '--wb-bg-raised', kind: 'ui', where: 'focus ring on panels' },
  { fg: '--wb-border-focus', bg: '--wb-bg-overlay', kind: 'ui', where: 'focus ring in the palette' },
  { fg: '--wb-accent-default', bg: '--wb-bg-raised', kind: 'ui', where: 'active tab underline' },
  { fg: '--wb-status-danger', bg: '--wb-bg-raised', kind: 'ui', where: 'error icon' },
  { fg: '--wb-status-warning', bg: '--wb-bg-raised', kind: 'ui', where: 'warning icon' },
];

/** One `[data-theme]`-style block's declarations, as `--wb-token` -> literal value. */
type Declarations = ReadonlyMap<string, string>;

/** Pulls the declarations out of the first rule whose selector list contains `selector`. */
export function parseBlock(css: string, selector: string): Declarations {
  const start = css.indexOf(selector);
  if (start === -1) {
    throw new Error(`tokens.css has no ${selector} block`);
  }
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) {
    throw new Error(`${selector} block in tokens.css is not closed`);
  }
  const declarations = new Map<string, string>();
  for (const line of css.slice(open + 1, close).split(';')) {
    const match = /(--wb-[\w-]+)\s*:\s*(.+)/s.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      declarations.set(match[1], match[2].trim());
    }
  }
  return declarations;
}

/**
 * Resolves a token to a `#rrggbb` literal, following `var(--wb-…)` indirection (the focus ring
 * is declared as `var(--wb-accent-default)`, which each theme redefines).
 */
export function resolveToken(token: string, declarations: Declarations, seen = new Set<string>()): string {
  if (seen.has(token)) {
    throw new Error(`token ${token} refers to itself`);
  }
  seen.add(token);
  const value = declarations.get(token);
  if (value === undefined) {
    throw new Error(`tokens.css does not define ${token}`);
  }
  const indirect = /^var\(\s*(--wb-[\w-]+)\s*\)$/.exec(value);
  return indirect?.[1] === undefined ? value : resolveToken(indirect[1], declarations, seen);
}

/** `#rgb`/`#rrggbb` to its three 0-255 channels. */
export function parseHex(value: string): readonly [number, number, number] {
  const hex = value.trim().replace('#', '');
  const full =
    hex.length === 3
      ? [...hex].map((channel) => channel + channel).join('')
      : hex.length === 6
        ? hex
        : (() => {
            throw new Error(`not a hex colour: ${value}`);
          })();
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const channels = parseHex(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** WCAG 2.x contrast ratio, 1:1 to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

export interface CheckResult {
  readonly theme: Theme;
  readonly pair: Pair;
  readonly fgValue: string;
  readonly bgValue: string;
  readonly ratio: number;
  readonly minimum: number;
  readonly passed: boolean;
}

/** Runs every pair against both themes' resolved palettes. */
export function checkTokens(css: string): readonly CheckResult[] {
  const dark = parseBlock(css, ':root');
  // Light restates only what differs, so it layers on top of the dark block's declarations.
  const light = new Map([...dark, ...parseBlock(css, "[data-theme='light']")]);
  const palettes: readonly (readonly [Theme, Declarations])[] = [
    ['dark', dark],
    ['light', light],
  ];

  return palettes.flatMap(([theme, declarations]) =>
    PAIRS.map((pair) => {
      const fgValue = resolveToken(pair.fg, declarations);
      const bgValue = resolveToken(pair.bg, declarations);
      const ratio = Math.round(contrastRatio(fgValue, bgValue) * 100) / 100;
      const minimum = pair.kind === 'text' ? TEXT_MINIMUM : UI_MINIMUM;
      return { theme, pair, fgValue, bgValue, ratio, minimum, passed: ratio >= minimum };
    }),
  );
}

/** The results as a GitHub-flavoured Markdown table — what the task report embeds. */
export function renderTable(results: readonly CheckResult[]): string {
  const rows = results.map(
    (result) =>
      `| ${result.theme} | \`${result.pair.fg}\` | \`${result.pair.bg}\` | ${result.pair.kind} | ` +
      `${result.ratio.toFixed(2)}:1 | ${result.minimum.toFixed(1)}:1 | ${result.passed ? 'pass' : 'FAIL'} | ` +
      `${result.pair.where} |`,
  );
  return [
    '| Theme | Foreground | Surface | Kind | Ratio | Minimum | Result | Where |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** True when this module is the process entrypoint, so importing it in a test runs nothing. */
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

async function main(): Promise<void> {
  const css = await readFile(TOKENS, 'utf-8');
  const results = checkTokens(css);
  const failures = results.filter((result) => !result.passed);

  if (process.argv.includes('--table')) {
    process.stdout.write(`${renderTable(results)}\n`);
    return;
  }

  for (const failure of failures) {
    process.stderr.write(
      `${failure.theme}: ${failure.pair.fg} (${failure.fgValue}) on ${failure.pair.bg} (${failure.bgValue}) ` +
        `is ${failure.ratio.toFixed(2)}:1, needs ${failure.minimum.toFixed(1)}:1 — ${failure.pair.where}\n`,
    );
  }
  if (failures.length > 0) {
    process.stderr.write(`contrast: ${String(failures.length)} of ${String(results.length)} pairs fail\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`contrast: all ${String(results.length)} token pairs pass (both themes)\n`);
}

if (isEntrypoint) {
  await main();
}
