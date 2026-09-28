/**
 * One sequence file: it round-trips byte for byte, writes nothing it does not define, and treats the
 * file as untrusted input: size, counts and names bounded, a newer `version` refused whole.
 */
import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import { parseSequenceFile, sequenceDocument, sequenceFilePath, sequenceSlugOf } from '../../../src/sequence/file.js';
import { createSequence, createSequenceStep, SEQUENCE_LIMITS } from '../../../src/sequence/model.js';
import type { SequenceDef } from '../../../src/sequence/model.js';

function checkout(): SequenceDef {
  return createSequence('Checkout flow', {
    id: 'S1',
    order: 2,
    description: 'Log in, then pay.',
    steps: [
      createSequenceStep('R-login', {
        id: 'T1',
        name: 'Log in',
        transfers: [
          { name: 'token', from: 'body', language: 'jsonpath', expression: '$.access_token', secret: true },
          { name: 'session', from: 'header', header: 'X-Session-Id', optional: true },
          { name: 'code', from: 'status' },
          { name: 'sid', from: 'cookie', cookie: 'sid' },
        ],
        assertions: [
          { type: 'status', equals: 200 },
          { type: 'header', header: 'Content-Type', matches: '^application/json' },
        ],
      }),
      createSequenceStep('R-pay', { id: 'T2', enabled: false, requestAssertions: false }),
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

describe('sequence file', () => {
  it('round-trips, and writes the same bytes twice', () => {
    const text = sequenceDocument(checkout());
    const parsed = parseSequenceFile(text, 'sequences/checkout-flow.sequence.yaml', 'Checkout-flow');
    expect(parsed).toEqual({ ...checkout(), slug: 'Checkout-flow' });
    expect(sequenceDocument(parsed)).toBe(text);
  });

  it('writes kind and version, and leaves defaults out', () => {
    const text = sequenceDocument(createSequence('Empty', { id: 'S0', steps: [createSequenceStep('R', { id: 'T' })] }));
    expect(text).toContain('kind: sequence');
    expect(text).toContain('version: 1');
    expect(text).not.toContain('enabled');
    expect(text).not.toContain('requestAssertions');
    expect(text).not.toContain('transfers');
    expect(text).not.toContain('assertions');
  });

  it('reads a minimal hand-written file with every default', () => {
    const parsed = parseSequenceFile(
      'kind: sequence\nversion: 1\nid: S\nname: Hand\norder: 0\nsteps:\n  - id: T\n    request: R\n',
      'sequences/hand.sequence.yaml',
      'hand',
    );
    expect(parsed.settings).toEqual({ stopOnFailure: true });
    expect(parsed.steps).toEqual([
      { id: 'T', requestId: 'R', enabled: true, requestAssertions: true, transfers: [], assertions: [] },
    ]);
  });

  it('does not write back a key it does not know', () => {
    const parsed = parseSequenceFile(
      [
        'kind: sequence',
        'version: 1',
        'id: S',
        'name: Extra',
        'order: 0',
        'future: 1',
        'steps:',
        '  - id: T',
        '    request: R',
        '    later: true',
        '    transfers: [{ name: a, from: status, script: "x" }]',
        '    assertions: [{ type: status, equals: 200, weight: 3 }]',
      ].join('\n'),
      'sequences/extra.sequence.yaml',
      'extra',
    );
    const text = sequenceDocument(parsed);
    for (const key of ['future', 'later', 'script', 'weight']) {
      expect(text).not.toContain(key);
    }
  });

  it('refuses a newer version by name, and a file that is not a sequence', () => {
    const base = 'id: S\nname: N\norder: 0\n';
    expect(codeOf(() => parseSequenceFile(`kind: sequence\nversion: 2\n${base}`, 'f', 's'))).toBe(
      'sequence-version-too-new',
    );
    expect(codeOf(() => parseSequenceFile(`kind: rest\nversion: 1\n${base}`, 'f', 's'))).toBe('sequence-file-invalid');
    expect(codeOf(() => parseSequenceFile('- a list', 'f', 's'))).toBe('sequence-file-invalid');
    expect(codeOf(() => parseSequenceFile('kind: [unclosed', 'f', 's'))).toBe('sequence-file-invalid');
    expect(codeOf(() => parseSequenceFile(`kind: sequence\n${base}`, 'f', 's'))).toBe('sequence-file-invalid');
  });

  it('refuses a file over the size limit before parsing it', () => {
    const huge = `kind: sequence\nversion: 1\nid: S\nname: N\norder: 0\ndescription: "${'x'.repeat(SEQUENCE_LIMITS.fileBytes)}"\n`;
    expect(codeOf(() => parseSequenceFile(huge, 'f', 's'))).toBe('sequence-file-invalid');
  });

  it('refuses more steps, transfers or assertions than the limits allow', () => {
    const step = (id: string) => createSequenceStep('R', { id });
    const tooManySteps = createSequence('N', {
      id: 'S',
      steps: Array.from({ length: SEQUENCE_LIMITS.steps + 1 }, (_, i) => step(`T${i}`)),
    });
    expect(codeOf(() => parseSequenceFile(sequenceDocument(tooManySteps), 'f', 's'))).toBe('sequence-file-invalid');

    const transfers = Array.from({ length: SEQUENCE_LIMITS.transfersPerStep + 1 }, (_, i) => ({
      name: `v${i}`,
      from: 'status' as const,
    }));
    const tooManyTransfers = createSequence('N', { id: 'S', steps: [createSequenceStep('R', { id: 'T', transfers })] });
    expect(codeOf(() => parseSequenceFile(sequenceDocument(tooManyTransfers), 'f', 's'))).toBe('sequence-file-invalid');

    const assertions = Array.from({ length: SEQUENCE_LIMITS.assertionsPerStep + 1 }, () => ({
      type: 'sla' as const,
      maxMs: 1,
    }));
    const tooManyAssertions = createSequence('N', {
      id: 'S',
      steps: [createSequenceStep('R', { id: 'T', assertions })],
    });
    expect(codeOf(() => parseSequenceFile(sequenceDocument(tooManyAssertions), 'f', 's'))).toBe(
      'sequence-file-invalid',
    );
  });

  it('refuses a transfer name that is not a plain identifier', () => {
    for (const name of ['', '1x', 'a b', 'secret:k', '${x}', 'a'.repeat(65)]) {
      const text = sequenceDocument(
        createSequence('N', {
          id: 'S',
          steps: [createSequenceStep('R', { id: 'T', transfers: [{ name, from: 'status' }] })],
        }),
      );
      expect(codeOf(() => parseSequenceFile(text, 'f', 's'))).toBe('sequence-file-invalid');
    }
  });

  it('refuses a match or header assertion without exactly one check, or with a pattern that does not compile', () => {
    for (const assertion of [
      '{ type: header, header: X-A }',
      '{ type: header, header: X-A, equals: a, exists: true }',
      '{ type: header, header: X-A, matches: "(" }',
    ]) {
      const text = `kind: sequence\nversion: 1\nid: S\nname: N\norder: 0\nsteps:\n  - id: T\n    request: R\n    assertions: [${assertion}]\n`;
      expect(codeOf(() => parseSequenceFile(text, 'f', 's'))).toBe('sequence-file-invalid');
    }
  });

  it('names its file from the slug, and reads the slug back from a file name', () => {
    expect(sequenceFilePath('checkout')).toBe('sequences/checkout.sequence.yaml');
    expect(sequenceSlugOf('checkout.sequence.yaml')).toBe('checkout');
    expect(sequenceSlugOf('.sequence.yaml')).toBeUndefined();
    expect(sequenceSlugOf('checkout.yaml')).toBeUndefined();
  });
});
