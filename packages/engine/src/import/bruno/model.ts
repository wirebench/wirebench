/**
 * Typed shapes of a parsed `.bru` file (spec §5.1): a sequence of named blocks, each a dictionary,
 * a text block or a list, nothing interpreted beyond the grammar.
 */

/** Which of the three `.bru` grammars a file is read with. */
export type BruGrammar = 'request' | 'folder' | 'environment';

export interface BruAnnotation {
  /** `number`, `boolean`, `object`, `description`, … without the `@`. */
  readonly name: string;
  readonly arg?: string;
}

export interface BruPair {
  readonly key: string;
  /**
   * The value as written: trimmed, a `'''` block with its four-character indent removed. A trailing
   * `@contentType(…)` and a multipart `@file(…)` stay in it for the converter.
   */
  readonly value: string;
  /** False when the key carried a `~`. */
  readonly enabled: boolean;
  /** The `@name` lines above the pair. */
  readonly annotations: readonly BruAnnotation[];
  /** A `[ … ]` list value (`tags`, `omitHeaders`), one item per line. */
  readonly list?: readonly string[];
  readonly line: number;
}

export type BruBlock =
  | { readonly kind: 'dict'; readonly name: string; readonly pairs: readonly BruPair[]; readonly line: number }
  | { readonly kind: 'text'; readonly name: string; readonly text: string; readonly line: number }
  | {
      readonly kind: 'list';
      readonly name: string;
      readonly items: readonly { readonly value: string; readonly enabled: boolean }[];
      readonly line: number;
    };

export interface BruFile {
  readonly blocks: readonly BruBlock[];
}
