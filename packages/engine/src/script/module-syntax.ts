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

/**
 * The `export {};` line Hoppscotch scripts may start with to mark a module context. It means nothing
 * here and is a syntax error in a script, so the runner blanks it (keeping the line count).
 */
export const MODULE_MARKER = /^[ \t]*export[ \t]*\{[ \t]*\}[ \t]*;?[ \t]*$/gm;
