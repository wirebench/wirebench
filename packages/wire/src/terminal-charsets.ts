/**
 * The character sets and terminal types a host's terminal may use (#427), free of zod for the renderer's eager
 * imports. The list must match `CHARSETS` in `@wirebench/ssh`, which decodes them (tested).
 */
export const TERMINAL_CHARSETS = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'iso-8859-1', label: 'ISO-8859-1 (Western European)' },
  { id: 'iso-8859-2', label: 'ISO-8859-2 (Central European)' },
  { id: 'iso-8859-5', label: 'ISO-8859-5 (Cyrillic)' },
  { id: 'iso-8859-7', label: 'ISO-8859-7 (Greek)' },
  { id: 'iso-8859-9', label: 'ISO-8859-9 (Turkish)' },
  { id: 'iso-8859-15', label: 'ISO-8859-15 (Western European, with €)' },
  { id: 'windows-1250', label: 'Windows-1250 (Central European)' },
  { id: 'windows-1251', label: 'Windows-1251 (Cyrillic)' },
  { id: 'windows-1252', label: 'Windows-1252 (Western European)' },
  { id: 'windows-1253', label: 'Windows-1253 (Greek)' },
  { id: 'windows-1254', label: 'Windows-1254 (Turkish)' },
  { id: 'windows-1257', label: 'Windows-1257 (Baltic)' },
  { id: 'cp850', label: 'CP850 (DOS Western European)' },
  { id: 'koi8-r', label: 'KOI8-R (Russian)' },
] as const;

export const DEFAULT_TERMINAL_CHARSET = 'utf-8';
export const DEFAULT_TERMINAL_TYPE = 'xterm-256color';

/** Offered as suggestions; any name the server's terminfo knows may be typed. */
export const COMMON_TERMINAL_TYPES = [
  'xterm-256color',
  'xterm',
  'vt100',
  'vt220',
  'linux',
  'screen-256color',
  'ansi',
] as const;

/** What `TERM` takes; the same rule as `TERM_NAME` in `@wirebench/ssh`. */
export const TERMINAL_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

/** A set's label; an id this version does not know (a file from a newer one) shows as written. */
export function charsetLabel(id: string): string {
  return TERMINAL_CHARSETS.find((c) => c.id === id)?.label ?? id;
}

/** Why a typed terminal type cannot be saved, or undefined. */
export function terminalTypeProblem(term: string | undefined): string | undefined {
  if (term === undefined || TERMINAL_TYPE_PATTERN.test(term)) return undefined;
  return 'Terminal type must be a name such as xterm-256color (letters, digits, . + _ -)';
}
