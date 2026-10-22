/**
 * A sample request message for a type, as the JSON the editor starts from — the counterpart of the
 * `?`-filled envelope a WSDL import generates. Every field is present once with a zero-ish value of
 * the right JSON shape, so the user replaces values rather than remembering names; a `oneof` shows
 * its first member only, and recursion stops at a fixed depth so a self-referencing tree does not
 * unroll for ever.
 */

import protobuf from 'protobufjs';
import { lookupMessageType } from './describe.js';
import type { ProtoSet } from './load.js';
import { wellKnownSample } from './well-known.js';

/** Options for {@link sampleMessage}. */
export interface SampleMessageOptions {
  /** Message nesting depth at which a message becomes `{}`. Defaults to 3. */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 3;

function scalarSample(type: string): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'bool':
      return false;
    case 'bytes':
      return '';
    case 'int64':
    case 'uint64':
    case 'sint64':
    case 'fixed64':
    case 'sfixed64':
      return '0';
    default:
      return 0;
  }
}

function fieldSample(field: protobuf.Field, depth: number, options: Required<SampleMessageOptions>): unknown {
  field.resolve();
  const resolved = field.resolvedType;
  if (resolved instanceof protobuf.Enum) {
    const names = Object.keys(resolved.values);
    return names[0] ?? 0;
  }
  if (resolved instanceof protobuf.Type) {
    return typeSample(resolved, depth + 1, options);
  }
  return scalarSample(field.type);
}

function typeSample(type: protobuf.Type, depth: number, options: Required<SampleMessageOptions>): unknown {
  const wellKnown = wellKnownSample(type.fullName.replace(/^\./, ''));
  if (wellKnown !== undefined) {
    return wellKnown;
  }
  if (depth > options.maxDepth) {
    return {};
  }
  const out: Record<string, unknown> = {};
  const seenOneofs = new Set<string>();
  for (const field of type.fieldsArray) {
    if (field.partOf !== null && !field.partOf.name.startsWith('_')) {
      if (seenOneofs.has(field.partOf.name)) {
        continue;
      }
      seenOneofs.add(field.partOf.name);
    }
    if (field instanceof protobuf.MapField) {
      out[field.name] = { key: fieldSample(field, depth, options) };
      continue;
    }
    const value = fieldSample(field, depth, options);
    out[field.name] = field.repeated ? [value] : value;
  }
  return out;
}

/**
 * A sample value for the message type `fullName`, as a plain JSON-ready value.
 *
 * @throws ProtoError `proto-type-unknown` when the set has no such message
 */
export function sampleMessage(set: ProtoSet, fullName: string, options: SampleMessageOptions = {}): unknown {
  return typeSample(lookupMessageType(set, fullName), 0, { maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH });
}

/** {@link sampleMessage} as pretty-printed JSON text, which is what a new request's body file holds. */
export function sampleMessageText(set: ProtoSet, fullName: string, options: SampleMessageOptions = {}): string {
  return `${JSON.stringify(sampleMessage(set, fullName, options), null, 2)}\n`;
}
