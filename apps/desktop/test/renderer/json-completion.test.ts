/**
 * Field-name completion in a JSON editor: which fields are offered, and what accepting one writes.
 *
 * The two omissions are the ones worth proving. A key the object already holds cannot be offered,
 * because JSON will not let it repeat; and once one member of a `oneof` is written, the rest cannot
 * be offered either, because protobuf clears the first when a second is set — so a completion list
 * that offered both would be handing the user a message they did not mean.
 */
import { describe, expect, it } from 'vitest';
import type { JsonCompletionContext } from '@wirebench/engine/json';
import { buildFieldCompletionItems } from '../../src/renderer/editor/json-completion.js';
import type { GrpcMessageFieldWire } from '../../src/shared/wire-types.js';

function field(overrides: Partial<GrpcMessageFieldWire> & { name: string }): GrpcMessageFieldWire {
  return { type: 'string', valueKind: 'scalar', repeated: false, ...overrides };
}

function context(overrides: Partial<JsonCompletionContext> = {}): JsonCompletionContext {
  return {
    path: [],
    partial: '',
    replaceRange: { start: 0, end: 0 },
    quoted: false,
    siblings: [],
    ...overrides,
  };
}

const FIELDS: GrpcMessageFieldWire[] = [
  field({ name: 'name', comment: 'Who to greet.' }),
  field({ name: 'big_number', type: 'int64' }),
  field({ name: 'tags', repeated: true }),
  field({ name: 'counts', type: 'string, int32', valueKind: 'map' }),
  field({ name: 'mood', type: 'wirebench.greet.Mood', valueKind: 'enum', enumValues: ['CHEERFUL', 'FORMAL'] }),
  field({ name: 'address', type: 'wirebench.common.Address', valueKind: 'message' }),
  field({ name: 'answered', type: 'bool', valueKind: 'scalar' }),
  field({ name: 'note', oneof: 'extra' }),
  field({ name: 'priority', type: 'int32', valueKind: 'scalar', oneof: 'extra' }),
];

/** The item for one field name, which must exist. */
function item(name: string, ctx = context()) {
  const found = buildFieldCompletionItems(FIELDS, ctx).find((candidate) => candidate.label === name);
  expect(found).toBeDefined();
  return found!;
}

describe('buildFieldCompletionItems', () => {
  it('offers every field of the message, in declaration order', () => {
    const items = buildFieldCompletionItems(FIELDS, context());
    expect(items.map((one) => one.label)).toEqual(FIELDS.map((one) => one.name));
    expect(items.map((one) => one.sortText)).toEqual([...items].map((one) => one.sortText).sort());
  });

  it('leaves out a key the object already holds', () => {
    const labels = buildFieldCompletionItems(FIELDS, context({ siblings: ['name', 'tags'] })).map((one) => one.label);
    expect(labels).not.toContain('name');
    expect(labels).not.toContain('tags');
    expect(labels).toContain('mood');
  });

  it('leaves out the rest of a oneof once one member is written', () => {
    const labels = buildFieldCompletionItems(FIELDS, context({ siblings: ['note'] })).map((one) => one.label);
    expect(labels).not.toContain('note');
    expect(labels).not.toContain('priority');
  });

  it('writes the key and an empty value of the right JSON shape', () => {
    expect(item('name').insertText).toBe('"name": "$0"');
    // The 64-bit scalars are strings in protobuf's JSON mapping, not numbers.
    expect(item('big_number').insertText).toBe('"big_number": "$0"');
    expect(item('answered').insertText).toBe('"answered": $0');
    expect(item('tags').insertText).toBe('"tags": [$0]');
    expect(item('counts').insertText).toBe('"counts": {$0}');
    expect(item('address').insertText).toBe('"address": {$0}');
    expect(item('mood').insertText).toBe('"mood": "$0"');
  });

  it('writes only the name when the cursor is already inside quotes', () => {
    expect(item('address', context({ quoted: true })).insertText).toBe('address');
  });

  it('shows the declared type, and repetition, as the item detail', () => {
    expect(item('address').detail).toBe('wirebench.common.Address');
    expect(item('tags').detail).toBe('repeated string');
    expect(item('counts').detail).toBe('map<string, int32>');
  });

  it('documents the comment, the oneof and an enum’s values', () => {
    expect(item('name').documentation).toContain('Who to greet.');
    expect(item('note').documentation).toContain('extra');
    expect(item('mood').documentation).toContain('CHEERFUL');
    expect(item('answered').documentation).toBeUndefined();
  });
});
