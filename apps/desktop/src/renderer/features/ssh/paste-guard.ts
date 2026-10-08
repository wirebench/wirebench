/** How many lines of a held paste the confirmation shows. */
export const PASTE_PREVIEW_LINES = 5;

/** One newline at the very end is what copying a command usually brings along; it is not a second line. */
function withoutTrailingNewline(text: string): string {
  return text.replace(/(?:\r\n|\n|\r)$/, '');
}

/**
 * Whether a paste goes straight to the shell or waits for a yes. A pasted script runs line by line,
 * so text with a line break inside it asks first (when the preference is on).
 */
export function guardPaste(text: string, prefs: { readonly confirmMultilinePaste: boolean }): 'send' | 'ask' {
  if (!prefs.confirmMultilinePaste) return 'send';
  return /[\r\n]/.test(withoutTrailingNewline(text)) ? 'ask' : 'send';
}

/** The first lines of a held paste, and how many more follow them. */
export function pastePreview(text: string): { readonly lines: readonly string[]; readonly remaining: number } {
  const all = withoutTrailingNewline(text).split(/\r\n|\r|\n/);
  return { lines: all.slice(0, PASTE_PREVIEW_LINES), remaining: Math.max(0, all.length - PASTE_PREVIEW_LINES) };
}
