/**
 * How the command palette ranks a command against what was typed. cmdk's own fuzzy score decides,
 * except that a search naming a command's group ranks that group first: "REST" lists the `REST: …`
 * commands before a fuzzy hit such as Close Tab, and "history" lists the History commands first.
 */
import { defaultFilter } from 'cmdk';
import { areaKeywords, isAreaLead, protocolKeywords } from '@shared/command-catalog.js';

/** A fuzzy match never outranks a group match: cmdk's score is at most 1, so it is scaled under it. */
const FUZZY_CEILING = 0.9;

/**
 * What a search naming a command's area scores for a command that is not one of the area's main
 * actions: above any fuzzy match, below the main actions, so "ssh" leads with Connect to Host… and
 * New Host… rather than with whichever SSH group sorts first.
 */
const AREA_SCORE = 0.95;

/**
 * Marks an area keyword of a command that is not one of its area's main actions. No search can
 * start with it: the filter strips it before matching and scores the match {@link AREA_SCORE}.
 */
const AREA_MEMBER = '\u0000area:';

/**
 * How much each character of a value lowers its fuzzy score: small enough never to reorder two
 * different scores, large enough to break a tie by the shorter value. cmdk scores "new host" the
 * same for New Host… and New Host Group…, and the longer one used to come first.
 */
const LENGTH_PENALTY = 1e-7;

/**
 * The names a search can pick a command's group by: its category, the prefix its label leads with
 * (`REST` in `REST: New Request`, `History` in `History: Clear`), its area's name (`ssh` for the
 * SSH area's commands, given an `id`) and the protocols it makes hosts for (`telnet` for New Host…).
 * These are the item's cmdk keywords.
 */
export function paletteKeywords(command: {
  readonly id?: string;
  readonly category: string;
  readonly label: string;
}): string[] {
  const prefix = /^([^:]+):\s/.exec(command.label)?.[1];
  const names = prefix === undefined || prefix === command.category ? [command.category] : [command.category, prefix];
  if (command.id === undefined) {
    return names;
  }
  const lead = isAreaLead(command.id);
  return [
    ...names,
    ...areaKeywords(command.id).map((area) => (lead ? area : `${AREA_MEMBER}${area}`)),
    ...protocolKeywords(command.id),
  ];
}

/** The keyword a search is matched against, without its {@link AREA_MEMBER} mark. */
export function keywordName(keyword: string): string {
  return keyword.startsWith(AREA_MEMBER) ? keyword.slice(AREA_MEMBER.length) : keyword;
}

/**
 * The palette's cmdk filter: 1 when the search starts a keyword (a group match, or the area name of
 * one of its main actions), {@link AREA_SCORE} when it starts the area name of another area
 * command, otherwise cmdk's own score for the value scaled below that, with ties going to the
 * shorter value, and 0 for no match. The keywords take no part in the fuzzy score: the value
 * already holds the category and the label, and counting them twice would reorder fuzzy matches.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase();
  if (query !== '' && keywords !== undefined) {
    const matched = keywords.filter((keyword) => keywordName(keyword).toLowerCase().startsWith(query));
    if (matched.some((keyword) => !keyword.startsWith(AREA_MEMBER))) {
      return 1;
    }
    if (matched.length > 0) {
      return AREA_SCORE;
    }
  }
  return defaultFilter(value, search) * FUZZY_CEILING * (1 - value.length * LENGTH_PENALTY);
}
