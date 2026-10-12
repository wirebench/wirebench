/**
 * Branches in a sequence file (#347): they round-trip, a file with any is written as version 2 and one
 * without stays version 1, and every loop's maximum is required and bounded.
 */
import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import { parseSequenceFile, sequenceDocument } from '../../../src/sequence/file.js';
import { createSequence, createSequenceStep, SEQUENCE_LIMITS } from '../../../src/sequence/model.js';
import type { BranchRule, SequenceDef } from '../../../src/sequence/model.js';

function poll(branches: readonly BranchRule[]): SequenceDef {
  return createSequence('Poll', {
    id: 'S',
    steps: [
      createSequenceStep('R-start', { id: 'T1' }),
      createSequenceStep('R-poll', { id: 'T2', branches }),
      createSequenceStep('R-fallback', { id: 'T3' }),
    ],
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isWirebenchError(error) ? error.code : 'not-a-wirebench-error';
  }
}

function parse(text: string) {
  return parseSequenceFile(text, 'sequences/poll.sequence.yaml', 'poll');
}

const HEADER = 'kind: sequence\nversion: 2\nid: S\nname: N\norder: 0\n';

function withBranches(yaml: string): string {
  return `${HEADER}steps:\n  - id: T1\n    request: R\n    branches:\n${yaml}\n  - id: T2\n    request: R\n`;
}

describe('sequence branches in the file', () => {
  it('round-trips every action and condition, and writes version 2', () => {
    const sequence = poll([
      {
        when: { type: 'match', language: 'jsonpath', expression: '$.state', equals: 'done', not: true },
        then: 'repeat',
        max: 10,
        delayMs: 2000,
      },
      { when: { type: 'outcome', equals: ['failed', 'errored'] }, then: 'goto', step: 'T3', max: 1 },
      { when: { type: 'status', equals: 404 }, then: 'skip-next' },
      { when: { type: 'header', header: 'Retry-After', exists: true }, then: 'goto', step: 'T1', max: 3 },
      { when: { type: 'soap-fault', expect: 'present' }, then: 'goto', step: 'T3', max: 1 },
    ]);
    const text = sequenceDocument(sequence);
    expect(text).toContain('version: 2');
    const parsed = parse(text);
    expect(parsed).toEqual({ ...sequence, slug: 'poll' });
    expect(sequenceDocument(parsed)).toBe(text);
  });

  it('keeps version 1 for a sequence without branches, and leaves an empty list out', () => {
    const text = sequenceDocument(poll([]));
    expect(text).toContain('version: 1');
    expect(text).not.toContain('branches');
    expect(parse(text).steps[1]).not.toHaveProperty('branches');
  });

  it('reads both versions, and refuses a newer one', () => {
    expect(parse(`${HEADER.replace('version: 2', 'version: 1')}`).name).toBe('N');
    expect(parse(HEADER).name).toBe('N');
    expect(codeOf(() => parse(HEADER.replace('version: 2', 'version: 3')))).toBe('sequence-version-too-new');
  });

  it('requires a max on goto and repeat, within bounds, and refuses one on skip-next', () => {
    const invalid = [
      '      - { when: { type: status, equals: 503 }, then: repeat }',
      '      - { when: { type: status, equals: 503 }, then: repeat, max: 0 }',
      `      - { when: { type: status, equals: 503 }, then: repeat, max: ${SEQUENCE_LIMITS.branchMax + 1} }`,
      '      - { when: { type: status, equals: 503 }, then: goto, step: T2 }',
      '      - { when: { type: status, equals: 503 }, then: skip-next, max: 2 }',
      `      - { when: { type: status, equals: 503 }, then: repeat, max: 2, delayMs: ${SEQUENCE_LIMITS.branchDelayMs + 1} }`,
      '      - { when: { type: status, equals: 503 }, then: skip-next, delayMs: 10 }',
    ];
    for (const rule of invalid) {
      expect(
        codeOf(() => parse(withBranches(rule))),
        rule,
      ).toBe('sequence-file-invalid');
    }
  });

  it('refuses a goto to a step that is not in the sequence, and one without a target', () => {
    expect(
      codeOf(() =>
        parse(withBranches('      - { when: { type: status, equals: 503 }, then: goto, step: T9, max: 1 }')),
      ),
    ).toBe('sequence-file-invalid');
    expect(
      codeOf(() => parse(withBranches('      - { when: { type: status, equals: 503 }, then: goto, max: 1 }'))),
    ).toBe('sequence-file-invalid');
  });

  it('refuses conditions it cannot evaluate, and too many rules', () => {
    for (const when of [
      '{ type: sla, maxMs: 10 }',
      '{ type: schema }',
      '{ type: outcome, equals: skipped }',
      '{ type: match, language: jsonpath, expression: $.a }',
      '{ type: header, header: X, equals: a, exists: true }',
    ]) {
      expect(
        codeOf(() => parse(withBranches(`      - { when: ${when}, then: skip-next }`))),
        when,
      ).toBe('sequence-file-invalid');
    }
    const many = Array.from(
      { length: SEQUENCE_LIMITS.branchesPerStep + 1 },
      () => '      - { when: { type: status, equals: 503 }, then: skip-next }',
    ).join('\n');
    expect(codeOf(() => parse(withBranches(many)))).toBe('sequence-file-invalid');
  });

  it('does not write back a key a rule does not define', () => {
    const parsed = parse(
      withBranches('      - { when: { type: status, equals: 503, weight: 2 }, then: repeat, max: 2, later: 1 }'),
    );
    const text = sequenceDocument(parsed);
    expect(text).not.toContain('weight');
    expect(text).not.toContain('later');
  });
});
