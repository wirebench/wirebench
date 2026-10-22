/**
 * The commands run lately from the palette, newest first, so an empty palette leads with them (G05).
 *
 * Kept in this window's `localStorage`: a convenience of one machine, like the window's size, and
 * nothing a project or a teammate needs. Storage that is missing or refuses (a locked-down profile)
 * leaves the list empty rather than failing the palette.
 */
import type { CommandId } from '@shared/commands.js';

/** How many recent commands the empty palette lists. */
export const RECENT_COMMANDS_MAX = 5;

const STORAGE_KEY = 'wirebench.palette.recentCommands';

/** `list` with `id` moved to the front, without duplicates, cut to `max`. */
export function pushRecent(list: readonly string[], id: string, max = RECENT_COMMANDS_MAX): string[] {
  return [id, ...list.filter((entry) => entry !== id)].slice(0, max);
}

/** The ids run lately, newest first; empty when nothing was stored or storage can't be read. */
export function recentCommandIds(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_COMMANDS_MAX)
      : [];
  } catch {
    return [];
  }
}

/** Notes that `id` was run from the palette. */
export function recordRecentCommand(id: CommandId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pushRecent(recentCommandIds(), id)));
  } catch {
    // Storage is a convenience here; a palette that can't remember still runs the command.
  }
}
