/** The shared pieces the layered script APIs are built from: each defines exactly its own names. */
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  PART_CRYPTO,
  PART_EXPECT,
  PART_PAIRS,
  PART_UNSUPPORTED,
  PART_VARIABLES,
} from '../../../src/script/api/layer-parts.js';

/** The names a part declares at its top level (a declaration starting in the first column). */
const declaredNames = (part: string): string[] =>
  [...part.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1] as string);

describe('the shared layer parts', () => {
  it('each part defines only its names', () => {
    const expected: ReadonlyArray<readonly [string, string, string[]]> = [
      ['PART_UNSUPPORTED', PART_UNSUPPORTED, ['unsupported']],
      ['PART_VARIABLES', PART_VARIABLES, ['asValue', 'variables']],
      ['PART_EXPECT', PART_EXPECT, ['typeName', 'same', 'chain', 'chaiExpect']],
      ['PART_PAIRS', PART_PAIRS, ['pairs']],
      [
        'PART_CRYPTO',
        PART_CRYPTO,
        ['Hex', 'Base64', 'Utf8', 'Latin1', 'words', 'text', 'hashOf', 'hmacOf', 'CryptoJS'],
      ],
    ];
    for (const [, part, names] of expected) expect(declaredNames(part)).toEqual(names);
  });

  it('each part is syntactically valid JavaScript', () => {
    for (const part of [PART_UNSUPPORTED, PART_VARIABLES, PART_EXPECT, PART_PAIRS, PART_CRYPTO]) {
      expect(() => new Script(part)).not.toThrow();
    }
  });
});
