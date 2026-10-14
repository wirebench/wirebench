import { z } from 'zod';

/** The smallest and largest terminal font size a host, a group or the app preferences may set. */
export const TERMINAL_FONT_SIZE = { min: 6, max: 72 } as const;

/** How a host or group's terminal looks; each field left out comes from the level above, then the app. */
export interface TerminalEntry {
  /** A colour scheme id; the desktop app falls back to its own setting for an id it does not know. */
  scheme?: string | undefined;
  fontSize?: number | undefined;
}

/**
 * `terminal: { scheme, fontSize }` on a host or group. The scheme is checked as an id only, not against
 * a list: a file shared with a newer app may name a scheme this one lacks. An empty block reads as none.
 */
export const terminalSchema = z
  .strictObject({
    scheme: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a scheme id (lower-case letters, digits and -)')
      .optional(),
    fontSize: z.number().int().min(TERMINAL_FONT_SIZE.min).max(TERMINAL_FONT_SIZE.max).optional(),
  })
  .transform((t): TerminalEntry | undefined => {
    const out: TerminalEntry = {};
    if (t.scheme !== undefined) out.scheme = t.scheme;
    if (t.fontSize !== undefined) out.fontSize = t.fontSize;
    return Object.keys(out).length === 0 ? undefined : out;
  })
  .optional();
