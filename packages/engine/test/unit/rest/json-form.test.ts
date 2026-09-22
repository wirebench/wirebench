/**
 * The JSON form model: a dereferenced (possibly cyclic) JSON Schema and a body value become a tree of
 * nodes addressed by JSON pointer, and structural edits on that tree come back as a new body value.
 */
import { describe, expect, it } from 'vitest';
import { applyJsonFormEdit, buildJsonForm, toWireSchema, type JsonFormNode } from '../../../src/rest/json-form.js';
import type { JsonSchema } from '../../../src/rest/openapi/model.js';
import { sampleFromSchema } from '../../../src/rest/openapi/sample.js';

function child(node: JsonFormNode, name: string): JsonFormNode {
  const found = node.children.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no child ${name} under '${node.id}'`);
  }
  return found;
}

const pet: JsonSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', title: 'Pet name', description: 'What it answers to' },
    age: { type: 'integer' },
    weight: { type: 'number', format: 'float' },
    status: { type: 'string', enum: ['available', 'sold'] },
    id: { type: 'integer', readOnly: true },
    legacy: { type: 'boolean', deprecated: true },
  },
};

describe('buildJsonForm', () => {
  it('shows required and optional properties with present flags and labels', () => {
    const form = buildJsonForm(pet, { name: 'Rex' });
    expect(form).toMatchObject({ id: '', kind: 'object', name: '', present: true, required: true });
    const name = child(form, 'name');
    expect(name).toMatchObject({
      id: '/name',
      kind: 'field',
      label: 'Pet name',
      description: 'What it answers to',
      required: true,
      present: true,
      valueType: 'string',
      value: 'Rex',
    });
    const age = child(form, 'age');
    expect(age).toMatchObject({ id: '/age', label: 'age', required: false, present: false, valueType: 'integer' });
    expect(age.value).toBeUndefined();
    expect(child(form, 'weight')).toMatchObject({ valueType: 'number', format: 'float' });
    expect(child(form, 'id').readOnly).toBe(true);
    expect(child(form, 'legacy').deprecated).toBe(true);
  });

  it('carries an enum field', () => {
    const form = buildJsonForm(pet, { name: 'Rex', status: 'sold' });
    expect(child(form, 'status')).toMatchObject({ kind: 'field', enum: ['available', 'sold'], value: 'sold' });
  });

  it('builds an array of objects with index-named items', () => {
    const schema: JsonSchema = { type: 'array', items: pet };
    const form = buildJsonForm(schema, [{ name: 'a' }, { name: 'b' }]);
    expect(form.kind).toBe('array');
    expect(form.children.map((item) => [item.id, item.name, item.kind])).toEqual([
      ['/0', '0', 'object'],
      ['/1', '1', 'object'],
    ]);
    expect(child(form.children[1]!, 'name')).toMatchObject({ id: '/1/name', value: 'b' });
  });

  it('escapes pointer segments', () => {
    const schema: JsonSchema = { type: 'object', properties: { 'a/b~c': { type: 'string' } } };
    expect(buildJsonForm(schema, { 'a/b~c': 'x' }).children[0]!.id).toBe('/a~1b~0c');
  });

  it('merges allOf', () => {
    const schema: JsonSchema = {
      allOf: [
        { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'boolean' } } },
      ],
    };
    const form = buildJsonForm(schema, { a: 'x' });
    expect(form.kind).toBe('object');
    expect(child(form, 'a')).toMatchObject({ required: true, present: true });
    expect(child(form, 'b')).toMatchObject({ required: false, present: false, valueType: 'boolean' });
  });

  it('makes oneOf a choice and picks the branch whose required keys the value has', () => {
    const schema: JsonSchema = {
      oneOf: [
        { type: 'object', title: 'Cat', required: ['meow'], properties: { meow: { type: 'string' } } },
        { type: 'object', title: 'Dog', required: ['bark'], properties: { bark: { type: 'string' } } },
      ],
    };
    const form = buildJsonForm(schema, { bark: 'woof' });
    expect(form).toMatchObject({ kind: 'choice', choices: ['Cat', 'Dog'], chosen: 1 });
    expect(form.children).toHaveLength(1);
    expect(child(form.children[0]!, 'bark').value).toBe('woof');
    expect(buildJsonForm(schema, { other: 1 }).chosen).toBe(0);
  });

  it('cuts a cyclic schema at the depth limit with an any node', () => {
    const node: { type: string; properties: Record<string, unknown> } = { type: 'object', properties: {} };
    node.properties.next = node;
    const schema = node as unknown as JsonSchema;
    let value: Record<string, unknown> = {};
    for (let index = 0; index < 5; index += 1) {
      value = { next: value };
    }
    let current = buildJsonForm(schema, value as never, { maxDepth: 3 });
    for (let level = 0; level < 3; level += 1) {
      expect(current.kind).toBe('object');
      current = child(current, 'next');
    }
    expect(current.kind).toBe('any');
    expect(current.id).toBe('/next/next/next');
    expect(current.value).toEqual({ next: { next: {} } });
    expect(current.children).toEqual([]);
  });

  it('keeps an undeclared property as an any node', () => {
    const form = buildJsonForm(pet, { name: 'Rex', extra: { deep: [1] } });
    expect(child(form, 'extra')).toMatchObject({ id: '/extra', kind: 'any', present: true, value: { deep: [1] } });
    const closed = buildJsonForm({ ...pet, additionalProperties: false }, { name: 'Rex', extra: 1 });
    expect(closed.children.some((node) => node.name === 'extra')).toBe(false);
  });

  it('marks an absent root', () => {
    expect(buildJsonForm(pet, undefined)).toMatchObject({ present: false });
  });
});

describe('applyJsonFormEdit', () => {
  it('sets a value and keeps unknown properties', () => {
    const next = applyJsonFormEdit(pet, { name: 'Rex', extra: 1 }, { kind: 'set-value', id: '/name', value: 'Max' });
    expect(next).toEqual({ name: 'Max', extra: 1 });
  });

  it('sets a value inside an array item without mutating the input', () => {
    const before = [{ name: 'a' }];
    const next = applyJsonFormEdit({ type: 'array', items: pet }, before, {
      kind: 'set-value',
      id: '/0/name',
      value: 'z',
    });
    expect(next).toEqual([{ name: 'z' }]);
    expect(before).toEqual([{ name: 'a' }]);
  });

  it('sets the root', () => {
    expect(applyJsonFormEdit(pet, undefined, { kind: 'set-value', id: '', value: { name: 'n' } })).toEqual({
      name: 'n',
    });
  });

  it('inserts an optional property from sampleFromSchema', () => {
    const address: JsonSchema = {
      type: 'object',
      required: ['city'],
      properties: { city: { type: 'string', example: 'Vienna' }, zip: { type: 'string' } },
    };
    const schema: JsonSchema = { type: 'object', properties: { address } };
    const next = applyJsonFormEdit(schema, { keep: true }, { kind: 'insert-optional', id: '/address' });
    expect(next).toEqual({ keep: true, address: sampleFromSchema(address) });
  });

  it('removes an optional property and an array item', () => {
    expect(applyJsonFormEdit(pet, { name: 'a', age: 3 }, { kind: 'remove', id: '/age' })).toEqual({ name: 'a' });
    const list: JsonSchema = { type: 'array', items: { type: 'string' } };
    expect(applyJsonFormEdit(list, ['a', 'b', 'c'], { kind: 'remove', id: '/1' })).toEqual(['a', 'c']);
  });

  it('adds an item from the item schema', () => {
    const list: JsonSchema = { type: 'array', items: pet };
    expect(applyJsonFormEdit(list, [], { kind: 'add-item', id: '' })).toEqual([sampleFromSchema(pet)]);
    const nested: JsonSchema = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } };
    expect(applyJsonFormEdit(nested, {}, { kind: 'add-item', id: '/tags' })).toEqual({ tags: [''] });
  });

  it('selects a choice branch', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        pet: {
          oneOf: [
            { type: 'object', required: ['meow'], properties: { meow: { type: 'string' } } },
            { type: 'object', required: ['bark'], properties: { bark: { type: 'string', example: 'woof' } } },
          ],
        },
      },
    };
    const next = applyJsonFormEdit(schema, { pet: { meow: 'x' } }, { kind: 'select-choice', id: '/pet', index: 1 });
    expect(next).toEqual({ pet: { bark: 'woof' } });
  });
});

describe('toWireSchema', () => {
  it('makes a cyclic schema acyclic and serialisable', () => {
    const node: { type: string; title: string; properties: Record<string, unknown>; items?: unknown } = {
      type: 'object',
      title: 'Node',
      properties: {},
    };
    node.properties.child = node;
    node.properties.list = { type: 'array', items: node };
    const wire = toWireSchema(node as unknown as JsonSchema, 4);
    expect(() => structuredClone(wire)).not.toThrow();
    const text = JSON.stringify(wire);
    expect(JSON.parse(text)).toEqual(wire);
    expect(wire.title).toBe('Node');
    expect(wire.properties?.child?.properties?.child?.title).toBe('Node');
  });
});
