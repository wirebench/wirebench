/**
 * WCAG contrast gate for the design tokens.
 *
 * Parses `apps/desktop/src/renderer/styles/tokens.css` for every colour theme × mode: Default
 * dark on `:root`, Default light under `[data-theme='light']`, and each palette's
 * `[data-palette='x']` (dark) and `[data-palette='x'][data-theme='light']` blocks, resolved the
 * way the browser cascades them (`resolvePalette`). It checks the foreground/surface pairs the UI
 * actually puts on screen, and fails a palette whose light block does not restate a token its
 * dark block sets (`findLeaks`), since that dark value would paint in light mode. Text pairs must clear WCAG AA's
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
import { PALETTES, type Palette } from '../packages/wire/src/palettes.ts';

const TOKENS = fileURLToPath(new URL('../apps/desktop/src/renderer/styles/tokens.css', import.meta.url));
const SITE_TOKENS = fileURLToPath(new URL('../site/src/styles/tokens.css', import.meta.url));

/** AA for body text; the UI's smallest type is 11px, so the large-text 3:1 exemption never applies. */
const TEXT_MINIMUM = 4.5;
/** SC 1.4.11 for borders, icons and other non-text indicators. */
const UI_MINIMUM = 3;

type Theme = 'dark' | 'light';
const THEMES: readonly Theme[] = ['dark', 'light'];
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
  // Accent-muted chips: the accent itself as text on accent-muted is near 2:1, so the chip's word
  // takes the default foreground and the chip keeps its tint (#803).
  {
    fg: '--wb-fg-default',
    bg: '--wb-accent-muted',
    kind: 'text',
    where: 'Experimental chip (Settings → Features), detected-format badge (Import)',
  },

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
  { fg: '--wb-highlight', bg: '--wb-bg-base', kind: 'ui', where: 'selected view-tab bar, changed-value dots' },
  { fg: '--wb-highlight', bg: '--wb-bg-raised', kind: 'ui', where: 'open editor-tab bar' },
  { fg: '--wb-fg-on-highlight', bg: '--wb-highlight', kind: 'text', where: 'count pills (explorer, console filters)' },
  { fg: '--wb-border-focus', bg: '--wb-bg-raised', kind: 'ui', where: 'focus ring on panels' },
  { fg: '--wb-border-focus', bg: '--wb-bg-overlay', kind: 'ui', where: 'focus ring in the palette' },
  { fg: '--wb-accent-default', bg: '--wb-bg-raised', kind: 'ui', where: 'active tab underline' },
  { fg: '--wb-status-danger', bg: '--wb-bg-raised', kind: 'ui', where: 'error icon' },
  { fg: '--wb-status-warning', bg: '--wb-bg-raised', kind: 'ui', where: 'warning icon' },
  { fg: '--wb-status-danger', bg: '--wb-bg-base', kind: 'ui', where: 'WebSocket timeline contract violation marker' },
  { fg: '--wb-status-warning', bg: '--wb-bg-base', kind: 'ui', where: 'WebSocket timeline unmatched-frame marker' },
  { fg: '--wb-fg-muted', bg: '--wb-bg-base', kind: 'ui', where: 'WebSocket timeline not-checked marker' },
  { fg: '--wb-fg-default', bg: '--wb-accent-muted', kind: 'ui', where: 'contract markers on a selected timeline row' },

  // The window frame (title bar, activity bar). Default and most palettes alias these to the
  // sunken surface and its text; Dusk and Rind paint a band of their own, and inside it every
  // text, icon, hover, accent and focus utility is pointed at the chrome tokens (tailwind.css).
  { fg: '--wb-fg-chrome', bg: '--wb-bg-chrome', kind: 'text', where: 'workspace name, hovered rail icon' },
  { fg: '--wb-fg-chrome-muted', bg: '--wb-bg-chrome', kind: 'text', where: 'title bar brand, search hint, rail icons' },
  {
    fg: '--wb-fg-chrome',
    bg: '--wb-bg-chrome-selected',
    kind: 'text',
    where: 'active rail item, hovered chrome control',
  },
  { fg: '--wb-fg-chrome', bg: '--wb-bg-chrome', kind: 'ui', where: 'focus ring on the chrome' },

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

/** One top-level rule: its comma-separated selectors (normalised) and the text between its braces. */
interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** `[data-palette="x"]` and `[data-palette='x']` are the same selector; so is any run of spaces. */
function normaliseSelector(selector: string): string {
  return selector.trim().replace(/"/g, "'").replace(/\s+/g, ' ');
}

/**
 * Every top-level rule in `css`, in source order. Comments are blanked first so a brace inside
 * one cannot open a block; at-rules (`@media …`) come back as rules whose selector is the at-rule
 * text, which no theme selector ever equals.
 */
function topLevelRules(css: string): readonly Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  const rules: Rule[] = [];
  let cursor = 0;
  for (;;) {
    const open = stripped.indexOf('{', cursor);
    if (open === -1) {
      return rules;
    }
    const selectorText = stripped.slice(cursor, open);
    const { body, end } = blockBody(stripped, open, selectorText.trim());
    rules.push({ selectors: selectorText.split(',').map(normaliseSelector), body });
    cursor = end;
  }
}

/** The attributes the root element carries: `data-theme` always, `data-palette` unless Default. */
interface RootAttributes {
  readonly theme: Theme;
  readonly palette: Palette;
}

/** A selector made only of `:root` and `[data-theme|data-palette='…']` parts — what tokens.css uses. */
const ROOT_SELECTOR = /^(:root)?((?:\[data-(?:theme|palette)='[\w-]+'\])*)$/;

/**
 * The specificity of `selector` if it matches the root element with `attributes`, else
 * `undefined`. Every part is a pseudo-class or an attribute selector, so specificity is the
 * number of parts: `:root` and `[data-theme='light']` are both (0,1,0), and
 * `[data-palette='x'][data-theme='light']` is (0,2,0).
 */
function rootSpecificity(selector: string, attributes: RootAttributes): number | undefined {
  const match = ROOT_SELECTOR.exec(selector);
  if (match === null || selector === '') {
    return undefined;
  }
  let parts = match[1] === undefined ? 0 : 1;
  for (const [, name, value] of (match[2] ?? '').matchAll(/\[data-(theme|palette)='([\w-]+)'\]/g)) {
    // Default puts no data-palette on the document, so no palette selector matches it.
    const actual =
      name === 'theme' ? attributes.theme : attributes.palette === 'default' ? undefined : attributes.palette;
    if (value !== actual) {
      return undefined;
    }
    parts += 1;
  }
  return parts;
}

/**
 * Every `--wb-*` token as the browser resolves it on `<html data-theme=mode data-palette=palette>`:
 * each matching rule applies in order of specificity, then source order, the later one winning.
 * That is the cascade spec §4 relies on — a palette's dark block beats `:root` (and, in light
 * mode, Default light) by coming later; its light block beats both by specificity.
 *
 * A palette with no blocks resolves to Default. Values are literal (`var(--wb-…)` stays as
 * written); pass the map to {@link resolveToken} for a colour.
 */
export function resolvePalette(css: string, palette: Palette, theme: Theme): Declarations {
  const matching = topLevelRules(css).flatMap((rule, index) => {
    const specificities = rule.selectors
      .map((selector) => rootSpecificity(selector, { theme, palette }))
      .filter((specificity): specificity is number => specificity !== undefined);
    return specificities.length === 0 ? [] : [{ specificity: Math.max(...specificities), index, rule }];
  });
  matching.sort((a, b) => a.specificity - b.specificity || a.index - b.index);
  const resolved = new Map<string, string>();
  for (const { rule } of matching) {
    for (const [token, value] of readDeclarations(rule.body)) {
      resolved.set(token, value);
    }
  }
  return resolved;
}

/** A token a palette's dark block sets and its light block does not restate. */
export interface Leak {
  readonly palette: Palette;
  readonly token: string;
}

/** The declarations of every rule whose selector list holds exactly `selector`, merged in order. */
function declarationsOf(rules: readonly Rule[], selector: string): Declarations {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selectors.includes(selector)) {
      for (const [token, value] of readDeclarations(rule.body)) {
        merged.set(token, value);
      }
    }
  }
  return merged;
}

/**
 * `[data-palette='x']` still matches in light mode, so a token it sets that
 * `[data-palette='x'][data-theme='light']` does not restate paints its dark value in light mode
 * (spec §4). Contrast alone may not catch that — a dark value can pass on a light surface by
 * luck — so the gate names every such token.
 */
export function findLeaks(css: string, palettes: readonly Palette[] = PALETTES): readonly Leak[] {
  const rules = topLevelRules(css);
  return palettes
    .filter((palette) => palette !== 'default')
    .flatMap((palette) => {
      const dark = declarationsOf(rules, `[data-palette='${palette}']`);
      const light = declarationsOf(rules, `[data-palette='${palette}'][data-theme='light']`);
      return [...dark.keys()].filter((token) => !light.has(token)).map((token) => ({ palette, token }));
    });
}

/** The palettes that have at least one block of their own in `css`. */
export function definedPalettes(css: string): readonly Palette[] {
  const selectors = new Set(topLevelRules(css).flatMap((rule) => rule.selectors));
  return PALETTES.filter(
    (palette) =>
      palette === 'default' ||
      selectors.has(`[data-palette='${palette}']`) ||
      selectors.has(`[data-palette='${palette}'][data-theme='light']`),
  );
}

export interface CheckResult {
  readonly palette: Palette;
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
  /** The palettes to check in the `data-theme` variant; defaults to every one of {@link PALETTES}. */
  readonly palettes?: readonly Palette[];
}

/** Gates every pair against one resolved token map. */
function checkPairs(
  palette: Palette,
  theme: Theme,
  declarations: Declarations,
  pairs: readonly Pair[],
): readonly CheckResult[] {
  return pairs.map((pair) => {
    const fgValue = resolveToken(pair.fg, declarations);
    const bgValue = resolveToken(pair.bg, declarations);
    const ratio = Math.round(contrastRatio(fgValue, bgValue) * 100) / 100;
    const minimum = pair.kind === 'text' ? TEXT_MINIMUM : UI_MINIMUM;
    return { palette, theme, pair, fgValue, bgValue, ratio, minimum, passed: ratio >= minimum };
  });
}

/**
 * Runs every pair against every palette × mode, each resolved the way the browser cascades it
 * ({@link resolvePalette}). The site's file (`light: 'media'`) has no palettes: it is checked as
 * Default in its two modes.
 */
export function checkTokens(css: string, options: CheckOptions = {}): readonly CheckResult[] {
  const { pairs = [...PAIRS, ...REPORT_PAIRS], light: lightSource = 'data-theme', palettes = PALETTES } = options;
  if (lightSource === 'data-theme') {
    return palettes.flatMap((palette) =>
      THEMES.flatMap((theme) => checkPairs(palette, theme, resolvePalette(css, palette, theme), pairs)),
    );
  }
  // In the media variant the light query also holds a `:root`, so the dark palette is read from
  // the stylesheet with that query cut out rather than from its first `:root` by position.
  const { start, end } = mediaSpan(css, 'prefers-color-scheme: light');
  const dark = parseBlock(css.slice(0, start) + css.slice(end), ':root');
  // Light restates only what differs, so it layers on top of the dark block's declarations.
  const light = new Map([...dark, ...parseMediaBlock(css, 'prefers-color-scheme: light')]);
  return [...checkPairs('default', 'dark', dark, pairs), ...checkPairs('default', 'light', light, pairs)];
}

/** How a failing pair reads in the gate's output: `sandstone/light: --wb-fg-subtle (…) on …`. */
export function describeFailure(result: CheckResult): string {
  return (
    `${result.palette}/${result.theme}: ${result.pair.fg} (${result.fgValue}) on ${result.pair.bg} ` +
    `(${result.bgValue}) ${result.ratio.toFixed(2)}:1 < ${result.minimum.toFixed(1)}:1 — ${result.pair.where}`
  );
}

/** How a leak reads in the gate's output. */
export function describeLeak(leak: Leak): string {
  return (
    `${leak.palette}: ${leak.token} is set in [data-palette='${leak.palette}'] but not restated in ` +
    `[data-palette='${leak.palette}'][data-theme='light'], so it leaks dark value into light`
  );
}

/** The results as a GitHub-flavoured Markdown table — what the task report embeds. */
export function renderTable(results: readonly CheckResult[]): string {
  const rows = results.map(
    (result) =>
      `| ${result.palette} | ${result.theme} | \`${result.pair.fg}\` | \`${result.pair.bg}\` | ${result.pair.kind} | ` +
      `${result.ratio.toFixed(2)}:1 | ${result.minimum.toFixed(1)}:1 | ${result.passed ? 'pass' : 'FAIL'} | ` +
      `${result.pair.where} |`,
  );
  return [
    '| Palette | Mode | Foreground | Surface | Kind | Ratio | Minimum | Result | Where |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
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

/** Prints one file's failures, leaks and verdict under its heading; true when it all passed. */
function report(heading: string, results: readonly CheckResult[], leaks: readonly Leak[]): boolean {
  const failures = results.filter((result) => !result.passed);
  process.stdout.write(`${heading}\n`);
  for (const failure of failures) {
    process.stderr.write(`${describeFailure(failure)}\n`);
  }
  for (const leak of leaks) {
    process.stderr.write(`${describeLeak(leak)}\n`);
  }
  if (failures.length > 0 || leaks.length > 0) {
    process.stderr.write(
      `contrast: ${String(failures.length)} of ${String(results.length)} pairs fail, ` +
        `${String(leaks.length)} tokens leak\n`,
    );
    return false;
  }
  const combinations = new Set(results.map((result) => `${result.palette}/${result.theme}`)).size;
  process.stdout.write(
    `contrast: all ${String(results.length)} token pairs pass (${String(combinations)} palette × mode combinations)\n`,
  );
  return true;
}

async function main(): Promise<void> {
  const checked = await Promise.all(
    TARGETS.map(async (target) => {
      const css = await readFile(target.path, 'utf-8');
      return {
        heading: target.heading,
        results: checkTokens(css, target.options),
        leaks: target.options.light === 'media' ? [] : findLeaks(css),
      };
    }),
  );

  if (process.argv.includes('--table')) {
    for (const { heading, results } of checked) {
      process.stdout.write(`## ${heading}\n\n${renderTable(results)}\n\n`);
    }
    return;
  }

  // Report every file before exiting, so a failure in one never hides the other's verdict.
  const passed = checked.map(({ heading, results, leaks }) => report(heading, results, leaks));
  if (passed.includes(false)) {
    process.exitCode = 1;
  }
}

if (isEntrypoint) {
  await main();
}
