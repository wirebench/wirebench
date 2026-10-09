import type { ITheme } from '@xterm/xterm';

/** One design token's current value, or `undefined` when the stylesheet does not define it. */
function token(styles: CSSStyleDeclaration, name: string): string | undefined {
  const value = styles.getPropertyValue(name).trim();
  return value === '' ? undefined : value;
}

/**
 * The terminal's colours from the app's tokens, so it follows the light and dark themes. The ANSI
 * colours the tokens carry (red, green, yellow, blue, cyan for the bright one) come from the status
 * colours, white from the foreground scale; xterm's own bright and white defaults are near-invisible on
 * the light surface. Black, magenta and normal cyan keep xterm's defaults.
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
    white: token(styles, '--wb-fg-muted'),
    brightRed: token(styles, '--wb-status-danger'),
    brightGreen: token(styles, '--wb-status-success'),
    brightYellow: token(styles, '--wb-status-warning'),
    brightBlue: token(styles, '--wb-status-info'),
    brightCyan: token(styles, '--wb-status-info'),
    brightWhite: token(styles, '--wb-fg-default'),
  };
  return Object.fromEntries(Object.entries(theme).filter(([, value]) => value !== undefined));
}

/** The app's mono font stack; a canvas cannot resolve `var(...)`, so the value is read here. */
export function monoFontFromCss(): string {
  return token(getComputedStyle(document.documentElement), '--wb-font-mono') ?? 'monospace';
}
