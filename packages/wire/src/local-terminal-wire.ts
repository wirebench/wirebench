import { z } from 'zod';

/**
 * Wire shapes of the local terminal tab (#410): a shell on this machine, in a pseudo-terminal in main. Writes,
 * resizes and output carry the same base64 bytes an SSH terminal's do.
 */

export const localTerminalOpenRequestSchema = z.strictObject({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
/** `shell` is the program's short name (`zsh`, `pwsh`), for the tab's title. */
export const localTerminalOpenResponseSchema = z.object({ sessionId: z.string(), shell: z.string() });
/** `data` is base64: terminal bytes are not always valid UTF-8. */
export const localTerminalWriteRequestSchema = z.strictObject({ sessionId: z.string(), data: z.string() });
export const localTerminalResizeRequestSchema = z.strictObject({
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const localTerminalCloseRequestSchema = z.strictObject({ sessionId: z.string() });

export const localTerminalDataEventSchema = z.object({ sessionId: z.string(), data: z.string() });
/** The shell ended on its own; a session closed from the app sends nothing. */
export const localTerminalExitEventSchema = z.object({ sessionId: z.string(), code: z.number().nullable() });

export type LocalTerminalOpenRequest = z.infer<typeof localTerminalOpenRequestSchema>;
export type LocalTerminalOpenResponse = z.infer<typeof localTerminalOpenResponseSchema>;
export type LocalTerminalWriteRequest = z.infer<typeof localTerminalWriteRequestSchema>;
export type LocalTerminalResizeRequest = z.infer<typeof localTerminalResizeRequestSchema>;
export type LocalTerminalCloseRequest = z.infer<typeof localTerminalCloseRequestSchema>;
