import type { ITheme } from '@xterm/xterm';

/** One design token's current value, or `undefined` when the stylesheet does not define it. */
function token(styles: CSSStyleDeclaration, name: string): string | undefined {
  const value = styles.getPropertyValue(name).trim();
  return value === '' ? undefined : value;
}

/**
 * The terminal's colours from the app's tokens, so it follows the light and dark themes. The ANSI
 * colours the tokens carry (red, green, yellow, blue) come from the status colours; the rest keep
 * xterm's defaults.
 */
export function themeFromCss(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const theme: Record<string, string | undefined> = {
    background: token(styles, '--wb-bg-sunken'),
    foreground: token(styles, '--wb-fg-default'),
    cursor: token(styles, '--wb-accent-default'),
    cursorAccent: token(styles, '--wb-bg-sunken'),
    selectionBackground: token(styles, '--wb-bg-selected'),
    red: token(styles, '--wb-status-danger'),
    green: token(styles, '--wb-status-success'),
    yellow: token(styles, '--wb-status-warning'),
    blue: token(styles, '--wb-status-info'),
  };
  return Object.fromEntries(Object.entries(theme).filter(([, value]) => value !== undefined));
}

/** The app's mono font stack; a canvas cannot resolve `var(...)`, so the value is read here. */
export function monoFontFromCss(): string {
  return token(getComputedStyle(document.documentElement), '--wb-font-mono') ?? 'monospace';
}
