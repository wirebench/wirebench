import { describe, expect, it } from 'vitest';
import { layerEdits } from '../../src/renderer/state/project.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';

/**
 * A snapshot from main carries only what has been written to disk. Both kinds of unwritten
 * edit — one still in flight, and one the user has staged in a tab and not saved — have to
 * survive it, or the editor silently reverts to the saved text while its tab still claims to
 * have unsaved changes.
 */
const saved = {
  id: 'r1',
  name: 'Saved name',
  envelopeXml: '<saved/>',
} as unknown as RequestDraft;

describe('layerEdits', () => {
  it('returns the saved request untouched when nothing is pending or staged', () => {
    expect(layerEdits(saved, undefined, undefined)).toBe(saved);
  });

  it('keeps an unsaved edit when a snapshot arrives', () => {
    const merged = layerEdits(saved, undefined, { envelopeXml: '<unsaved/>' });

    expect(merged.envelopeXml).toBe('<unsaved/>');
    expect(merged.name).toBe('Saved name');
  });

  it('keeps an in-flight edit when a snapshot arrives', () => {
    expect(layerEdits(saved, { name: 'In flight' }, undefined).name).toBe('In flight');
  });

  it('prefers the staged edit over an in-flight one for the same field', () => {
    // The staged edit is the more recent thing the user typed, so it wins.
    const merged = layerEdits(saved, { name: 'In flight' }, { name: 'Just typed' });

    expect(merged.name).toBe('Just typed');
  });

  it('combines edits that touch different fields', () => {
    const merged = layerEdits(saved, { name: 'In flight' }, { envelopeXml: '<unsaved/>' });

    expect(merged).toMatchObject({ name: 'In flight', envelopeXml: '<unsaved/>' });
  });
});
