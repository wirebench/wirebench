// @vitest-environment node
/**
 * The `*-sequence` project changes: what they make, that every edit is held to the same rules as a
 * file from a teammate, and that a new slug stays clear of a sequence file this build refused.
 */
import { describe, expect, it } from 'vitest';
import { createProject } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import {
  addSequence,
  duplicateSequence,
  refusedSequenceSlugs,
  removeSequence,
  toSequenceWire,
  updateSequence,
} from '../src/main/project-sequence-mutations.js';
import type { SequenceStepWire } from '../src/shared/wire-types.js';

const empty = (): Project => createProject('P', { id: 'P1' });

function step(overrides: Partial<SequenceStepWire> = {}): SequenceStepWire {
  return {
    id: 'T1',
    requestId: 'R1',
    enabled: true,
    requestAssertions: true,
    transfers: [],
    assertions: [],
    ...overrides,
  };
}

describe('sequence mutations', () => {
  it('adds, renames (with a new slug), updates steps, duplicates and removes', () => {
    const added = addSequence(empty(), 'Checkout');
    const id = added.createdId ?? '';
    expect(added.project.sequences.map((s) => [s.name, s.slug, s.order])).toEqual([['Checkout', 'Checkout', 0]]);

    const renamed = updateSequence(added.project, id, {
      name: 'Pay',
      settings: { stopOnFailure: false, stepTimeoutMs: 1500 },
      steps: [
        step({
          name: 'Log in',
          transfers: [{ name: 'token', from: 'body', language: 'jsonpath', expression: '$.t', secret: true }],
          assertions: [{ type: 'header', header: 'X-A', exists: true }],
        }),
      ],
    });
    const sequence = renamed.project.sequences[0];
    expect(sequence).toMatchObject({
      name: 'Pay',
      slug: 'Pay',
      settings: { stopOnFailure: false, stepTimeoutMs: 1500 },
    });
    expect(toSequenceWire(sequence!).steps).toEqual([
      step({
        name: 'Log in',
        transfers: [{ name: 'token', from: 'body', language: 'jsonpath', expression: '$.t', secret: true }],
        assertions: [{ type: 'header', header: 'X-A', exists: true }],
      }),
    ]);

    const copied = duplicateSequence(renamed.project, id);
    const copy = copied.project.sequences[1];
    expect(copy).toMatchObject({ name: 'Pay copy', slug: 'Pay copy', order: 1 });
    expect(copy?.id).not.toBe(id);
    expect(copy?.steps[0]?.id).not.toBe('T1');

    const removed = removeSequence(copied.project, id);
    expect(removed.project.sequences.map((s) => [s.name, s.order])).toEqual([['Pay copy', 0]]);
  });

  it('refuses an edit a file would be refused for, naming what is wrong', () => {
    const { project, createdId } = addSequence(empty(), 'S');
    for (const bad of [
      step({ transfers: [{ name: '${x}', from: 'status' }] }),
      step({ assertions: [{ type: 'header', header: 'X', matches: '(' }] }),
      step({ assertions: [{ type: 'header', header: 'X' }] }),
    ]) {
      expect(() => updateSequence(project, createdId ?? '', { steps: [bad] })).toThrowError(
        expect.objectContaining({ code: 'sequence-invalid' }),
      );
    }
    expect(() =>
      updateSequence(project, createdId ?? '', { steps: Array.from({ length: 101 }, (_, i) => step({ id: `T${i}` })) }),
    ).toThrowError(expect.objectContaining({ code: 'sequence-invalid' }));
  });

  it('keeps a new or renamed sequence off the slug of a file the load refused', () => {
    const reserved = refusedSequenceSlugs([
      { code: 'sequence-version-too-new', file: 'sequences/checkout.sequence.yaml' },
      { code: 'missing-body', file: 'apis/x/requests/y.request.yaml' },
    ]);
    expect([...reserved]).toEqual(['checkout']);
    const added = addSequence(empty(), 'checkout', reserved);
    expect(added.project.sequences[0]?.slug).toBe('checkout-2');
    const other = addSequence(added.project, 'Other', reserved);
    const renamed = updateSequence(other.project, other.createdId ?? '', { name: 'checkout' }, reserved);
    expect(renamed.project.sequences[1]?.slug).toBe('checkout-3');
  });

  it('refuses an unknown sequence', () => {
    expect(() => removeSequence(empty(), 'nope')).toThrowError(expect.objectContaining({ code: 'unknown-entity' }));
  });
});
