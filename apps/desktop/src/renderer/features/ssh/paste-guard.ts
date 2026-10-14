/** How many lines of a held paste the confirmation shows. */
export const PASTE_PREVIEW_LINES = 5;

/** One newline at the very end is what copying a command usually brings along; it is not a second line. */
function withoutTrailingNewline(text: string): string {
  return text.replace(/(?:\r\n|\n|\r)$/, '');
}

/**
 * Control characters the shell or the terminal could act on: C0 apart from tab and line breaks, DEL, and C1.
 * An ESC can end a bracketed paste early (`ESC [201~`) and have what follows run as if typed.
 */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

/** Whether the text holds a control character other than tab and line breaks. */
export function hasControlCharacters(text: string): boolean {
  return CONTROL.test(text);
}

/**
 * Whether a paste goes straight to the shell or waits for a yes. A pasted script runs line by line,
 * so text with a line break inside it asks first (when the preference is on). Text holding control
 * characters, and a paste a broadcast takes to more than one pane, always ask, whatever the preference says.
 */
export function guardPaste(
  text: string,
  prefs: { readonly confirmMultilinePaste: boolean },
  receivers = 1,
): 'send' | 'ask' {
  if (receivers > 1 || hasControlCharacters(text)) return 'ask';
  if (!prefs.confirmMultilinePaste) return 'send';
  return /[\r\n]/.test(withoutTrailingNewline(text)) ? 'ask' : 'send';
}

/** A control character as the preview shows it: `\x1b` for ESC, and so on. */
function escaped(char: string): string {
  return `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`;
}

/** The first lines of a held paste, control characters escaped, and how many more lines follow them. */
export function pastePreview(text: string): { readonly lines: readonly string[]; readonly remaining: number } {
  const all = withoutTrailingNewline(text)
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(CONTROL_ALL, escaped));
  return { lines: all.slice(0, PASTE_PREVIEW_LINES), remaining: Math.max(0, all.length - PASTE_PREVIEW_LINES) };
}
