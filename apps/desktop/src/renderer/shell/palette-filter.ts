/**
 * How the command palette ranks a command against what was typed, from the top: an area's main
 * actions when the search names the area ("ssh", "soap"), then commands whose name has a word the
 * search starts, then commands the search matches only by a tag (their category or label prefix),
 * then the rest of an area, then cmdk's own fuzzy score. "request" so lists New Request above Copy as
 * cURL, which is only in the Request group (#732 X16).
 */
import { defaultFilter } from 'cmdk';
import { areaKeywords, isAreaLead, protocolKeywords } from '@shared/command-catalog.js';

/** A fuzzy match never outranks a group match: cmdk's score is at most 1, so it is scaled under it. */
const FUZZY_CEILING = 0.9;

/** A word of the command's name starts with the search. */
const NAME_SCORE = 0.99;

/** The search starts one of the command's tags (its category, its label's prefix, a protocol) and nothing more. */
const TAG_SCORE = 0.97;

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

/** Marks a keyword of one of its area's main actions: a search starting it scores 1. */
const AREA_LEAD = '\u0000lead:';

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
  readonly aliases?: readonly string[];
}): string[] {
  const prefix = /^([^:]+):\s/.exec(command.label)?.[1];
  const names = [
    ...(prefix === undefined || prefix === command.category ? [command.category] : [command.category, prefix]),
    ...(command.aliases ?? []),
  ];
  if (command.id === undefined) {
    return names;
  }
  const lead = isAreaLead(command.id);
  return [
    ...names,
    ...areaKeywords(command.id).map((area) => `${lead ? AREA_LEAD : AREA_MEMBER}${area}`),
    ...protocolKeywords(command.id).map((protocol) => (lead ? `${AREA_LEAD}${protocol}` : protocol)),
  ];
}

/** The keyword a search is matched against, without its {@link AREA_MEMBER} or {@link AREA_LEAD} mark. */
export function keywordName(keyword: string): string {
  if (keyword.startsWith(AREA_MEMBER)) return keyword.slice(AREA_MEMBER.length);
  if (keyword.startsWith(AREA_LEAD)) return keyword.slice(AREA_LEAD.length);
  return keyword;
}

/** Whether a word of `value`'s name, after its category (the first keyword), starts with `query`. */
function nameStarts(value: string, query: string, category: string | undefined): boolean {
  const lower = value.toLowerCase();
  const prefix = category?.toLowerCase();
  const name = prefix !== undefined && lower.startsWith(`${prefix} `) ? lower.slice(prefix.length + 1) : lower;
  return name.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query));
}

/**
 * The palette's cmdk filter: 1 when the search starts a main action's area keyword,
 * {@link NAME_SCORE} when it starts a word of the command's name, {@link TAG_SCORE} when it starts
 * only a tag, {@link AREA_SCORE} when it starts the area name of another area command, otherwise
 * cmdk's own score for the value scaled below that, with ties going to the shorter value, and 0 for
 * no match. The keywords take no part in the fuzzy score: the value already holds the category and
 * the label, and counting them twice would reorder fuzzy matches.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase();
  if (query !== '' && keywords !== undefined) {
    const matched = keywords.filter((keyword) => keywordName(keyword).toLowerCase().startsWith(query));
    if (matched.some((keyword) => keyword.startsWith(AREA_LEAD))) return 1;
    // A tag match whose name also says it ranks with the names; one that only the tag says, below.
    if (nameStarts(value, query, keywords[0])) return NAME_SCORE;
    if (matched.some((keyword) => !keyword.startsWith(AREA_MEMBER))) return TAG_SCORE;
    if (matched.length > 0) return AREA_SCORE;
  }
  return defaultFilter(value, search) * FUZZY_CEILING * (1 - value.length * LENGTH_PENALTY);
}
