import { describe, expect, it } from 'vitest';
import { BANNED_TERMS, findBannedTerms, isExemptPath } from './check-banned-terms.js';

// The terms are never written out here either — they come from the exported list, so this file
// does not trip the very check it exercises.
const sample = BANNED_TERMS[0]!;

describe('findBannedTerms', () => {
  it('reports nothing for prose that describes the behaviour itself', () => {
    expect(findBannedTerms('a.ts', '// The `${#Env#x}` property syntax, expanded at send time.\n')).toEqual([]);
  });

  it('reports each banned term with its one-based line and the offending text', () => {
    const text = `matches ${sample.toUpperCase()} here`;
    expect(findBannedTerms('docs/x.md', `fine\n${text}\nfine\n`)).toEqual([
      { file: 'docs/x.md', line: 2, term: sample, text },
    ]);
  });

  it('matches every listed term regardless of case', () => {
    for (const term of BANNED_TERMS) {
      expect(findBannedTerms('a.ts', term.toUpperCase())).toHaveLength(1);
    }
  });
});

describe('isExemptPath', () => {
  it('exempts the checker, the format constants file and everything under the legacy fixtures folder', () => {
    expect(isExemptPath('scripts/check-banned-terms.ts')).toBe(true);
    expect(isExemptPath('packages/engine/src/soap/legacy-project/format.ts')).toBe(true);
    expect(isExemptPath('fixtures/legacy-soap-project/minimal.xml')).toBe(true);
    expect(isExemptPath('fixtures/legacy-soap-project/nested/deep.xml')).toBe(true);
  });

  it('checks every other path, including siblings of the exempt ones', () => {
    expect(isExemptPath('packages/engine/src/soap/legacy-project/parse.ts')).toBe(false);
    expect(isExemptPath('packages/engine/src/soap/legacy-project/format.test.ts')).toBe(false);
    expect(isExemptPath('fixtures/legacy-soap-project-extra/a.xml')).toBe(false);
    expect(isExemptPath('docs/specs/2026-09-18-legacy-soap-project-import-design.md')).toBe(false);
  });
});
