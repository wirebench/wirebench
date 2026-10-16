/**
 * Language ids, kept out of `monaco.ts` so a module that only needs the id does not import Monaco.
 * `xml-language.ts` is reached from the shell's commands at startup; importing the id from
 * `monaco.ts` there pulled all of Monaco into the window's first script.
 */

/** The Monaco language id every Wirebench editor uses. */
export const XML_LANGUAGE_ID = 'xml';
