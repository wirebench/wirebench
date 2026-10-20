import type { ITheme, Terminal } from '@xterm/xterm';
import type { PreferencesWire } from '../../../shared/wire-base.js';
import type { Platform } from '../../lib/platform.js';
import { PREFERENCE_LIMITS } from '../../state/preference-limits.js';
import { APP_SCHEME_ID, schemeById, type TerminalScheme } from './terminal-schemes.js';
import { monoFontFromCss, themeFromCss } from './terminal-theme.js';

/** The Preferences → Terminal fields that set how a terminal looks. */
export type TerminalLookPreferences = Pick<
  PreferencesWire['terminal'],
  'fontFamily' | 'fontSize' | 'lineHeight' | 'colorScheme'
>;

/** What a host or group sets for its terminals (`terminal:` in hosts.yaml, resolved); unset fields take the preferences. */
export interface TerminalOverride {
  readonly scheme?: string | undefined;
  readonly fontSize?: number | undefined;
}

/** The xterm options a terminal is drawn with. */
export interface TerminalAppearance {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly theme: ITheme;
}

/** The scrollbar's slider as the foreground at low opacity; nothing (xterm's own) for a colour not `#rrggbb`. */
export function sliderColours(
  foreground: string,
): Pick<ITheme, 'scrollbarSliderBackground' | 'scrollbarSliderHoverBackground' | 'scrollbarSliderActiveBackground'> {
  if (!/^#[0-9a-f]{6}$/i.test(foreground)) return {};
  return {
    scrollbarSliderBackground: `${foreground}26`,
    scrollbarSliderHoverBackground: `${foreground}40`,
    scrollbarSliderActiveBackground: `${foreground}59`,
  };
}

/** xterm's colours from a built-in palette. */
export function themeFromScheme(scheme: TerminalScheme): ITheme {
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = scheme.ansi;
  return {
    background: scheme.background,
    foreground: scheme.foreground,
    cursor: scheme.cursor,
    cursorAccent: scheme.background,
    selectionBackground: scheme.selection,
    // From the scheme's own text, faint: xterm's default slider was an opaque grey slab on a light scheme (S17).
    ...sliderColours(scheme.foreground),
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

const known = (id: string | undefined): id is string => id === APP_SCHEME_ID || schemeById(id) !== undefined;

/**
 * The scheme a terminal shows: the host's, else the preferences', else the app theme. An id this version
 * does not know (a hosts.yaml written by a newer one) is passed over rather than refused.
 */
export function effectiveSchemeId(prefs: TerminalLookPreferences, override?: TerminalOverride): string {
  return [override?.scheme, prefs.colorScheme].find(known) ?? APP_SCHEME_ID;
}

/** A scheme's colours; `app` (and anything unknown) reads the app's tokens now, so call it again on a theme switch. */
export function terminalTheme(id: string): ITheme {
  const scheme = schemeById(id);
  return scheme === undefined ? themeFromCss() : themeFromScheme(scheme);
}

/** The family the preferences name, first, with the app's mono stack behind it; none names the stack alone. */
export function terminalFontFamily(family: string | undefined): string {
  const mono = monoFontFromCss();
  const name = family?.trim().replaceAll('"', '') ?? '';
  return name === '' ? mono : `"${name}", ${mono}`;
}

const { min: MIN_SIZE, max: MAX_SIZE } = PREFERENCE_LIMITS['terminal.fontSize'];

/** A font size kept inside what the preferences accept. */
export function clampFontSize(size: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)));
}

/**
 * How a terminal looks: the host or group's scheme and size over the preferences, then this terminal's own
 * zoom (⌘+ / ⌘−) on top, in whole points.
 */
export function terminalAppearance(
  prefs: TerminalLookPreferences,
  override?: TerminalOverride,
  zoom = 0,
): TerminalAppearance {
  return {
    fontFamily: terminalFontFamily(prefs.fontFamily),
    fontSize: clampFontSize((override?.fontSize ?? prefs.fontSize) + zoom),
    lineHeight: prefs.lineHeight,
    theme: terminalTheme(effectiveSchemeId(prefs, override)),
  };
}

/** A terminal's zoom after ⌘+, ⌘− or ⌘0, in points over `base`, never past the size limits. */
export function nextZoom(base: number, zoom: number, chord: 'in' | 'out' | 'reset'): number {
  if (chord === 'reset') return 0;
  return clampFontSize(base + zoom + (chord === 'in' ? 1 : -1)) - base;
}

/**
 * Sets what changed on a live terminal. Returns whether the cell size may have changed (font or line
 * height), so the caller refits it to its holder.
 */
export function applyAppearance(term: Terminal, look: TerminalAppearance): boolean {
  const options = term.options;
  const resized =
    options.fontFamily !== look.fontFamily ||
    options.fontSize !== look.fontSize ||
    options.lineHeight !== look.lineHeight;
  if (options.fontFamily !== look.fontFamily) options.fontFamily = look.fontFamily;
  if (options.fontSize !== look.fontSize) options.fontSize = look.fontSize;
  if (options.lineHeight !== look.lineHeight) options.lineHeight = look.lineHeight;
  options.theme = look.theme;
  return resized;
}

/** ⌘+ / ⌘− / ⌘0 (Ctrl elsewhere): zoom the focused terminal in, out, or back to its size. */
export function zoomChord(event: KeyboardEvent, platform: Platform): 'in' | 'out' | 'reset' | undefined {
  const mod = platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod || event.altKey) return undefined;
  if (event.key === '=' || event.key === '+') return 'in';
  if (event.shiftKey) return undefined;
  if (event.key === '-') return 'out';
  if (event.key === '0') return 'reset';
  return undefined;
}
