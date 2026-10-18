/**
 * Module syntax a script cannot use. Both patterns are anchored to a line start and have no
 * repetition that can overlap, so they are linear. They live apart from any layer so the importer
 * and the runner can share them without loading one.
 */

/**
 * A top-level `import` statement at the start of a line: the keyword followed by a name, `{`, `*` or
 * a quoted specifier. It is a syntax error in a script, not a call, so the runner refuses it by name
 * and the importer lists it. `importantFlag = 1`, `imports.push(1)`, `import(x)` and `import.meta`
 * are not matched.
 */
export const TOP_LEVEL_IMPORT = /^[ \t]*import(?:[ \t]+[\w{*]|[ \t]*[{*"'])/m;

/** Why a top-level import is refused: the runner's message and the converter's TODO give it. */
export const TOP_LEVEL_IMPORT_REASON = 'a script cannot load modules, so remove the import statement';

/** One line: everything up to the next line break. `.` never matches a line break, so it is linear. */
const LINE = /^.*$/gm;
/** `export {}` with an optional `;`, once the line's leading and trailing blanks are gone. */
const MARKER_BODY = /^export[ \t]*\{[ \t]*\}[ \t]*;?$/;

/** The line without its leading and trailing spaces and tabs. */
function unpadded(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) start += 1;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return line.slice(start, end);
}

/**
 * Blanks the `export {};` lines Hoppscotch scripts may start with to mark a module context. The line
 * means nothing here and is a syntax error in a script, so the runner and the converter both blank it,
 * keeping the line count.
 */
export function blankModuleMarkers(text: string): string {
  return text.replace(LINE, (line) => (MARKER_BODY.test(unpadded(line)) ? '' : line));
}
