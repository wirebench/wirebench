/**
 * How the command palette ranks a command against what was typed. cmdk's own fuzzy score decides,
 * except that a search naming a command's group ranks that group first: "REST" lists the `REST: …`
 * commands before a fuzzy hit such as Close Tab, and "history" lists the History commands first.
 */
import { defaultFilter } from 'cmdk';
import { areaKeywords } from '@shared/command-catalog.js';

/** A fuzzy match never outranks a group match: cmdk's score is at most 1, so it is scaled under it. */
const FUZZY_CEILING = 0.9;

/**
 * The names a search can pick a command's group by: its category, the prefix its label leads with
 * (`REST` in `REST: New Request`, `History` in `History: Clear`), and its area's name (`ssh` for the
 * SSH area's commands, given an `id`). These are the item's cmdk keywords.
 */
export function paletteKeywords(command: {
  readonly id?: string;
  readonly category: string;
  readonly label: string;
}): string[] {
  const prefix = /^([^:]+):\s/.exec(command.label)?.[1];
  const names = prefix === undefined || prefix === command.category ? [command.category] : [command.category, prefix];
  return command.id === undefined ? names : [...names, ...areaKeywords(command.id)];
}

/**
 * The palette's cmdk filter: 1 when the search starts a keyword (a group match), otherwise cmdk's
 * own score for the value scaled below that, and 0 for no match. The keywords take no part in the
 * fuzzy score: the value already holds the category and the label, and counting them twice would
 * reorder fuzzy matches.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase();
  if (query !== '' && keywords?.some((keyword) => keyword.toLowerCase().startsWith(query)) === true) {
    return 1;
  }
  return defaultFilter(value, search) * FUZZY_CEILING;
}
