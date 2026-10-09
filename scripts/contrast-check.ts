/**
 * WCAG contrast gate for the design tokens.
 *
 * Parses `apps/desktop/src/renderer/styles/tokens.css` for both themes (dark on `:root`, light
 * under `[data-theme='light']`, which inherits every token it does not restate) and checks the
 * foreground/surface pairs the UI actually puts on screen. Text pairs must clear WCAG AA's
 * 4.5:1; borders, icons and other non-text UI must clear 3:1 (WCAG 2.1 SC 1.4.11).
 *
 * It also checks `site/src/styles/tokens.css`, the landing site's own small palette. That file
 * follows the visitor's system theme, so its light values sit under
 * `@media (prefers-color-scheme: light) { :root { … } }` instead of a `data-theme` selector, and
 * it is gated on its own, shorter pair list (`SITE_PAIRS`).
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
const SITE_TOKENS = fileURLToPath(new URL('../site/src/styles/tokens.css', import.meta.url));

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
  { fg: '--wb-accent-default', bg: '--wb-bg-sunken', kind: 'text', where: "the Code panel's curl flags" },
  { fg: '--wb-fg-on-accent', bg: '--wb-accent-default', kind: 'text', where: 'primary buttons' },
  { fg: '--wb-fg-on-accent', bg: '--wb-status-danger', kind: 'text', where: 'destructive buttons, problem badges' },
  { fg: '--wb-fg-on-accent', bg: '--wb-status-warning', kind: 'text', where: 'orphaned-node badge' },

  // The method badge: both as a filled chip (when variant="chip") and Postman-style colored text.
  { fg: '--wb-fg-on-accent', bg: '--wb-method-get', kind: 'text', where: 'GET badge chip' },
  { fg: '--wb-fg-on-accent', bg: '--wb-method-post', kind: 'text', where: 'POST badge chip' },
  { fg: '--wb-fg-on-accent', bg: '--wb-method-put', kind: 'text', where: 'PUT badge chip' },
  { fg: '--wb-fg-on-accent', bg: '--wb-method-patch', kind: 'text', where: 'PATCH badge chip' },
  { fg: '--wb-fg-on-accent', bg: '--wb-method-delete', kind: 'text', where: 'DELETE badge chip' },
  { fg: '--wb-fg-on-accent', bg: '--wb-method-other', kind: 'text', where: 'custom method badge chip' },
  { fg: '--wb-method-get', bg: '--wb-bg-raised', kind: 'text', where: 'GET method text (sidebar)' },
  { fg: '--wb-method-post', bg: '--wb-bg-raised', kind: 'text', where: 'POST method text (sidebar)' },
  { fg: '--wb-method-put', bg: '--wb-bg-raised', kind: 'text', where: 'PUT method text (sidebar)' },
  { fg: '--wb-method-patch', bg: '--wb-bg-raised', kind: 'text', where: 'PATCH method text (sidebar)' },
  { fg: '--wb-method-delete', bg: '--wb-bg-raised', kind: 'text', where: 'DELETE method text (sidebar)' },
  { fg: '--wb-method-other', bg: '--wb-bg-raised', kind: 'text', where: 'custom method text (sidebar)' },
  { fg: '--wb-method-get', bg: '--wb-bg-base', kind: 'text', where: 'GET method text (editor)' },
  { fg: '--wb-method-post', bg: '--wb-bg-base', kind: 'text', where: 'POST method text (editor)' },
  { fg: '--wb-method-put', bg: '--wb-bg-base', kind: 'text', where: 'PUT method text (editor)' },
  { fg: '--wb-method-patch', bg: '--wb-bg-base', kind: 'text', where: 'PATCH method text (editor)' },
  { fg: '--wb-method-delete', bg: '--wb-bg-base', kind: 'text', where: 'DELETE method text (editor)' },
  { fg: '--wb-method-other', bg: '--wb-bg-base', kind: 'text', where: 'custom method text (editor)' },

  { fg: '--wb-method-get', bg: '--wb-accent-muted', kind: 'text', where: 'GET method text (selected explorer row)' },
  { fg: '--wb-method-post', bg: '--wb-accent-muted', kind: 'text', where: 'POST method text (selected explorer row)' },
  { fg: '--wb-method-put', bg: '--wb-accent-muted', kind: 'text', where: 'PUT method text (selected explorer row)' },
  {
    fg: '--wb-method-patch',
    bg: '--wb-accent-muted',
    kind: 'text',
    where: 'PATCH method text (selected explorer row)',
  },
  {
    fg: '--wb-method-delete',
    bg: '--wb-accent-muted',
    kind: 'text',
    where: 'DELETE method text (selected explorer row)',
  },
  {
    fg: '--wb-method-other',
    bg: '--wb-accent-muted',
    kind: 'text',
    where: 'custom method text (selected explorer row)',
  },

  // The selected row of a response's Events list: every part of it (time, chip, id, preview) turns
  // to the default foreground on the selection, since the quieter tokens do not hold on it.
  { fg: '--wb-fg-default', bg: '--wb-accent-muted', kind: 'text', where: 'selected event row' },

  // Status text: response codes in the status bar, problem rows, keystore chips.
  { fg: '--wb-status-success', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar 2xx' },
  { fg: '--wb-status-success', bg: '--wb-bg-raised', kind: 'text', where: 'keystore "Loaded" chip' },
  { fg: '--wb-status-danger', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar failure' },
  { fg: '--wb-status-danger', bg: '--wb-bg-raised', kind: 'text', where: 'problem rows, error copy' },
  { fg: '--wb-status-warning', bg: '--wb-bg-sunken', kind: 'text', where: 'status bar warning count' },
  { fg: '--wb-status-warning', bg: '--wb-bg-raised', kind: 'text', where: 'warning rows, required marks' },
  { fg: '--wb-status-success', bg: '--wb-bg-base', kind: 'text', where: 'REST response contract chip (Contract ✓)' },
  { fg: '--wb-status-warning', bg: '--wb-bg-base', kind: 'text', where: 'REST response contract chip (problems)' },
  { fg: '--wb-status-info', bg: '--wb-bg-raised', kind: 'text', where: 'informational copy' },
  // The SSH terminal paints on the sunken surface; its ANSI red/green/yellow are the rows above.
  { fg: '--wb-status-info', bg: '--wb-bg-sunken', kind: 'text', where: 'SSH terminal ANSI blue' },

  // Non-text: hairlines, the focus ring, and the severity icons.
  { fg: '--wb-border-strong', bg: '--wb-bg-base', kind: 'ui', where: 'input borders' },
  { fg: '--wb-border-strong', bg: '--wb-bg-raised', kind: 'ui', where: 'input borders on panels' },
  { fg: '--wb-border-focus', bg: '--wb-bg-base', kind: 'ui', where: 'focus ring' },
  { fg: '--wb-border-focus', bg: '--wb-bg-raised', kind: 'ui', where: 'focus ring on panels' },
  { fg: '--wb-border-focus', bg: '--wb-bg-overlay', kind: 'ui', where: 'focus ring in the palette' },
  { fg: '--wb-accent-default', bg: '--wb-bg-raised', kind: 'ui', where: 'active tab underline' },
  { fg: '--wb-status-danger', bg: '--wb-bg-raised', kind: 'ui', where: 'error icon' },
  { fg: '--wb-status-warning', bg: '--wb-bg-raised', kind: 'ui', where: 'warning icon' },
  { fg: '--wb-status-danger', bg: '--wb-bg-base', kind: 'ui', where: 'WebSocket timeline contract violation marker' },
  { fg: '--wb-status-warning', bg: '--wb-bg-base', kind: 'ui', where: 'WebSocket timeline unmatched-frame marker' },
  { fg: '--wb-fg-muted', bg: '--wb-bg-base', kind: 'ui', where: 'WebSocket timeline not-checked marker' },
  { fg: '--wb-fg-default', bg: '--wb-accent-muted', kind: 'ui', where: 'contract markers on a selected timeline row' },

  // Panel drag handles: sidebar/console sit on the base surface, the slide-over's handle on it too.
  { fg: '--wb-handle-hover', bg: '--wb-bg-base', kind: 'ui', where: 'panel handle, hovered' },
  { fg: '--wb-handle-active', bg: '--wb-bg-base', kind: 'ui', where: 'panel handle, dragging' },
];

/**
 * The `html` CLI report is a standalone document, not part of the desktop shell, but it reuses
 * these same tokens for its outcome marks on its own page background. It has no place in `PAIRS`
 * above (that list is annotated by the desktop component that renders each pair), so its
 * foreground/background combinations get their own short list here.
 */
const REPORT_PAIRS: readonly Pair[] = [
  { fg: '--wb-fg-default', bg: '--wb-bg-base', kind: 'text', where: 'html report body copy' },
  { fg: '--wb-status-success', bg: '--wb-bg-base', kind: 'text', where: 'html report passed mark' },
  { fg: '--wb-status-danger', bg: '--wb-bg-base', kind: 'text', where: 'html report failed/errored mark' },
  { fg: '--wb-status-warning', bg: '--wb-bg-base', kind: 'text', where: 'html report skipped mark' },
];

/**
 * The foreground/surface combinations the landing site renders, by the part of the page that
 * renders each. The site's palette is a handful of tokens, so this is the whole list: body and
 * secondary copy on each of its three surfaces, links on the two surfaces they sit on, and the
 * button label on the accent.
 *
 * `--wb-border` is deliberately not here. The site's hairlines are decorative, not an indicator a
 * person needs in order to operate the page, so SC 1.4.11 does not gate them.
 */
export const SITE_PAIRS: readonly Pair[] = [
  { fg: '--wb-fg-default', bg: '--wb-bg-base', kind: 'text', where: 'page body copy' },
  { fg: '--wb-fg-default', bg: '--wb-bg-raised', kind: 'text', where: 'cards, feature panels' },
  { fg: '--wb-fg-default', bg: '--wb-bg-sunken', kind: 'text', where: 'code blocks, footer' },
  { fg: '--wb-fg-muted', bg: '--wb-bg-base', kind: 'text', where: 'secondary copy, captions' },
  { fg: '--wb-fg-muted', bg: '--wb-bg-raised', kind: 'text', where: 'card descriptions' },
  { fg: '--wb-fg-muted', bg: '--wb-bg-sunken', kind: 'text', where: 'footer links, code captions' },
  { fg: '--wb-accent-default', bg: '--wb-bg-base', kind: 'text', where: 'links' },
  { fg: '--wb-accent-default', bg: '--wb-bg-raised', kind: 'text', where: 'links inside cards' },
  { fg: '--wb-accent-fg', bg: '--wb-accent-default', kind: 'text', where: 'primary button label' },
];

/** One `[data-theme]`-style block's declarations, as `--wb-token` -> literal value. */
type Declarations = ReadonlyMap<string, string>;

/**
 * The text between the braces of the rule whose opening `{` is the first one at or after `from`,
 * and the index one past its closing brace.
 *
 * Brace counting, not "the first `}`": a block may hold a nested at-rule (or, for a media query,
 * whole nested rules), and stopping at the inner closing brace would silently drop every
 * declaration after it.
 */
function blockBody(css: string, from: number, label: string): { readonly body: string; readonly end: number } {
  const open = css.indexOf('{', from);
  if (open === -1) {
    throw new Error(`${label} block in tokens.css is not closed`);
  }
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const character = css[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return { body: css.slice(open + 1, index), end: index + 1 };
      }
    }
  }
  throw new Error(`${label} block in tokens.css is not closed`);
}

/** Reads every `--wb-token: value;` out of a block body. */
function readDeclarations(body: string): Declarations {
  const declarations = new Map<string, string>();
  for (const line of body.split(';')) {
    const match = /(--wb-[\w-]+)\s*:\s*(.+)/s.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      declarations.set(match[1], match[2].trim());
    }
  }
  return declarations;
}

/** Pulls the declarations out of the first rule whose selector list contains `selector`. */
export function parseBlock(css: string, selector: string): Declarations {
  const start = css.indexOf(selector);
  if (start === -1) {
    throw new Error(`tokens.css has no ${selector} block`);
  }
  return readDeclarations(blockBody(css, start, selector).body);
}

/** Where `@media (<query>) { … }` sits in `css`: its span, and the text between its braces. */
function mediaSpan(
  css: string,
  query: string,
): { readonly start: number; readonly end: number; readonly body: string } {
  const escaped = query
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s*');
  const media = new RegExp(`@media\\s*\\(\\s*${escaped}\\s*\\)`).exec(css);
  if (media === null) {
    throw new Error(`tokens.css has no @media (${query}) block`);
  }
  const { body, end } = blockBody(css, media.index + media[0].length, `@media (${query})`);
  return { start: media.index, end, body };
}

/**
 * The `:root` declarations inside `@media (<query>) { … }`, and only those: a `:root` block
 * outside the query (the site's dark defaults) is not read. `query` is the condition without its
 * parentheses, e.g. `prefers-color-scheme: light`.
 */
export function parseMediaBlock(css: string, query: string): Declarations {
  return parseBlock(mediaSpan(css, query).body, ':root');
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

export interface CheckOptions {
  /** The pairs to gate; defaults to the desktop shell's (`PAIRS` and `REPORT_PAIRS`). */
  readonly pairs?: readonly Pair[];
  /** Where the light theme lives: a `[data-theme='light']` block (default) or a light `@media` query. */
  readonly light?: 'data-theme' | 'media';
}

/** Runs every pair against both themes' resolved palettes. */
export function checkTokens(css: string, options: CheckOptions = {}): readonly CheckResult[] {
  const { pairs = [...PAIRS, ...REPORT_PAIRS], light: lightSource = 'data-theme' } = options;
  // In the media variant the light query also holds a `:root`, so the dark palette is read from
  // the stylesheet with that query cut out rather than from its first `:root` by position.
  let darkCss = css;
  if (lightSource === 'media') {
    const { start, end } = mediaSpan(css, 'prefers-color-scheme: light');
    darkCss = css.slice(0, start) + css.slice(end);
  }
  const dark = parseBlock(darkCss, ':root');
  // Light restates only what differs, so it layers on top of the dark block's declarations.
  const lightOverrides =
    lightSource === 'media'
      ? parseMediaBlock(css, 'prefers-color-scheme: light')
      : parseBlock(css, "[data-theme='light']");
  const light = new Map([...dark, ...lightOverrides]);
  const palettes: readonly (readonly [Theme, Declarations])[] = [
    ['dark', dark],
    ['light', light],
  ];

  return palettes.flatMap(([theme, declarations]) =>
    pairs.map((pair) => {
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

interface Target {
  readonly heading: string;
  readonly path: string;
  readonly options: CheckOptions;
}

/** The files the gate reads: the desktop shell's tokens, then the landing site's. */
const TARGETS: readonly Target[] = [
  { heading: 'desktop shell', path: TOKENS, options: {} },
  { heading: 'landing site', path: SITE_TOKENS, options: { pairs: SITE_PAIRS, light: 'media' } },
];

/** Prints one file's failures and verdict under its heading; true when every pair passed. */
function report(heading: string, results: readonly CheckResult[]): boolean {
  const failures = results.filter((result) => !result.passed);
  process.stdout.write(`${heading}\n`);
  for (const failure of failures) {
    process.stderr.write(
      `${failure.theme}: ${failure.pair.fg} (${failure.fgValue}) on ${failure.pair.bg} (${failure.bgValue}) ` +
        `is ${failure.ratio.toFixed(2)}:1, needs ${failure.minimum.toFixed(1)}:1 — ${failure.pair.where}\n`,
    );
  }
  if (failures.length > 0) {
    process.stderr.write(`contrast: ${String(failures.length)} of ${String(results.length)} pairs fail\n`);
    return false;
  }
  process.stdout.write(`contrast: all ${String(results.length)} token pairs pass (both themes)\n`);
  return true;
}

async function main(): Promise<void> {
  const checked = await Promise.all(
    TARGETS.map(async (target) => ({
      heading: target.heading,
      results: checkTokens(await readFile(target.path, 'utf-8'), target.options),
    })),
  );

  if (process.argv.includes('--table')) {
    for (const { heading, results } of checked) {
      process.stdout.write(`## ${heading}\n\n${renderTable(results)}\n\n`);
    }
    return;
  }

  // Report every file before exiting, so a failure in one never hides the other's verdict.
  const passed = checked.map(({ heading, results }) => report(heading, results));
  if (passed.includes(false)) {
    process.exitCode = 1;
  }
}

if (isEntrypoint) {
  await main();
}
