/**
 * A worker-free JSON tokenizer for Monaco.
 *
 * `monaco-core.ts` deliberately leaves out Monaco's own JSON support, because in this version it
 * exists only as a language *service* backed by its own web worker — four of those dominated the
 * renderer's bundle, and none of what they provide (schema validation, hovers) is anything a REST
 * body editor needs. Highlighting is: a JSON body with no colour is markedly harder to read.
 *
 * So JSON is registered here as a Monarch grammar, which runs in the renderer with no worker at
 * all. It colours strings, keys, numbers, keywords and punctuation, and marks an unterminated
 * string invalid. It does not validate: a malformed body is the server's answer to give, and
 * *Format* already reports a parse failure where the user asked for one.
 */
import type { monaco as MonacoNamespace } from './monaco-core.js';

/** The Monaco language id for JSON. */
export const JSON_LANGUAGE_ID = 'json';

let registered = false;

/** Registers the JSON language once. Safe to call from every editor that might show one. */
export function registerJsonLanguage(monaco: typeof MonacoNamespace): void {
  if (registered) {
    return;
  }
  registered = true;

  monaco.languages.register({ id: JSON_LANGUAGE_ID, extensions: ['.json'], aliases: ['JSON', 'json'] });
  monaco.languages.setLanguageConfiguration(JSON_LANGUAGE_ID, {
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE_ID, {
    tokenizer: {
      root: [
        // A string followed by a colon is a key; anything else quoted is a value. The lookahead
        // keeps the two apart without a second state.
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
        [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\]]/, '@brackets'],
        [/[:,]/, 'delimiter'],
        [/\s+/, 'white'],
      ],
    },
  });
}
