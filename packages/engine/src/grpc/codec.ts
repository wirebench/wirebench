/**
 * JSON ⇄ protobuf bytes for one message type. The user edits a message as JSON in the canonical
 * mapping the protobuf specification defines; the wire wants the binary encoding. This module is
 * where the two meet, and it is deliberately strict on the way in — an unknown field, a value of the
 * wrong shape or a malformed well-known type is an error naming the field, never a silently dropped
 * key — and lenient on the way out, because whatever the server sent is what the user needs to see.
 */

import protobuf from 'protobufjs';
import { ProtoError } from '../errors.js';
import { lookupMessageType, qualifiedName } from './proto/describe.js';
import type { ProtoSet } from './proto/load.js';
import {
  durationFromJson,
  durationToJson,
  fieldMaskFromJson,
  fieldMaskToJson,
  isWrapperType,
  timestampFromJson,
  timestampToJson,
} from './proto/well-known.js';

const TO_OBJECT_OPTIONS: protobuf.IConversionOptions = {
  longs: String,
  enums: String,
  bytes: String,
  defaults: false,
  arrays: false,
  objects: false,
  oneofs: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, reason: string): ProtoError {
  return new ProtoError('grpc-message-invalid', `${path}: ${reason}`, { details: { path, reason } });
}

/** `snake_case` → `lowerCamelCase`, the JSON name the specification derives from a field name. */
function jsonName(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

/** Finds a field by its declared name or its JSON name, both of which the JSON mapping accepts. */
function fieldNamed(type: protobuf.Type, key: string): protobuf.Field | undefined {
  const direct = type.fields[key];
  if (direct !== undefined) {
    return direct;
  }
  return type.fieldsArray.find((field) => jsonName(field.name) === key);
}

/** Message-level conversions for well-known types, JSON form → parser form. `undefined` means "ordinary message". */
function wellKnownFromJson(type: protobuf.Type, value: unknown, path: string, set: ProtoSet): unknown {
  const name = qualifiedName(type);
  const field = (id: number): string => type.fieldsById[id]?.name ?? String(id);
  switch (name) {
    case 'google.protobuf.Timestamp': {
      if (isRecord(value)) return value;
      const { seconds, nanos } = timestampFromJson(value);
      return { [field(1)]: seconds, [field(2)]: nanos };
    }
    case 'google.protobuf.Duration': {
      if (isRecord(value)) return value;
      const { seconds, nanos } = durationFromJson(value);
      return { [field(1)]: seconds, [field(2)]: nanos };
    }
    case 'google.protobuf.FieldMask':
      return isRecord(value) ? value : { [field(1)]: fieldMaskFromJson(value).paths };
    case 'google.protobuf.Struct':
      if (!isRecord(value)) throw invalid(path, 'a Struct must be a JSON object');
      return {
        [field(1)]: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, valueFromJson(type.root, v)])),
      };
    case 'google.protobuf.Value':
      return valueFromJson(type.root, value);
    case 'google.protobuf.ListValue':
      if (!Array.isArray(value)) throw invalid(path, 'a ListValue must be a JSON array');
      return { [field(1)]: value.map((item) => valueFromJson(type.root, item)) };
    case 'google.protobuf.Empty':
      return {};
    case 'google.protobuf.Any':
      return anyFromJson(type, value, path, set);
    default:
      if (isWrapperType(name)) {
        return isRecord(value) && 'value' in value ? value : { [field(1)]: value };
      }
      return undefined;
  }
}

function valueFromJson(root: protobuf.Root, value: unknown): Record<string, unknown> {
  const type = root.lookupType('google.protobuf.Value');
  const field = (id: number): string => type.fieldsById[id]?.name ?? String(id);
  if (value === null || value === undefined) return { [field(1)]: 0 };
  if (typeof value === 'number') return { [field(2)]: value };
  if (typeof value === 'string') return { [field(3)]: value };
  if (typeof value === 'boolean') return { [field(4)]: value };
  if (Array.isArray(value)) {
    const list = root.lookupType('google.protobuf.ListValue');
    return { [field(6)]: { [list.fieldsById[1]?.name ?? 'values']: value.map((item) => valueFromJson(root, item)) } };
  }
  const struct = root.lookupType('google.protobuf.Struct');
  return {
    [field(5)]: {
      [struct.fieldsById[1]?.name ?? 'fields']: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, valueFromJson(root, v)]),
      ),
    },
  };
}

function anyFromJson(type: protobuf.Type, value: unknown, path: string, set: ProtoSet): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(path, 'an Any must be a JSON object with an "@type"');
  const { '@type': typeUrl, ...rest } = value;
  if (typeof typeUrl !== 'string' || typeUrl === '') {
    if ('type_url' in value || 'typeUrl' in value) return value;
    throw invalid(path, 'an Any needs an "@type" such as "type.googleapis.com/pkg.Message"');
  }
  const innerName = typeUrl.slice(typeUrl.lastIndexOf('/') + 1);
  const inner = lookupMessageType(set, innerName);
  const innerJson =
    wellKnownFromJson(inner, rest['value'], `${path}.value`, set) !== undefined && 'value' in rest
      ? rest['value']
      : rest;
  const bytes = encodeMessage(set, innerName, innerJson);
  return { [type.fieldsById[1]?.name ?? 'type_url']: typeUrl, [type.fieldsById[2]?.name ?? 'value']: bytes };
}

const INT64_TYPES = new Set(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);
const INT32_TYPES = new Set(['int32', 'uint32', 'sint32', 'fixed32', 'sfixed32']);
const FLOAT_TYPES = new Set(['float', 'double']);

/**
 * Checks a scalar or enum value against its declared type, the way the JSON mapping reads it: a
 * 64-bit integer may be a string, a float may be `"NaN"` or `"Infinity"`, an enum may be a name or
 * a number, bytes are base64. The parser's own `verify` wants its internal forms (a `Long`, an enum
 * number), so the checking lives here and `fromObject` does the converting.
 */
function checkScalar(field: protobuf.Field, value: unknown, path: string): unknown {
  const type = field.type;
  const resolved = field.resolvedType;
  if (resolved instanceof protobuf.Enum) {
    if (typeof value === 'string') {
      if (!(value in resolved.values)) {
        throw invalid(path, `"${value}" is not a value of ${qualifiedName(resolved)}`);
      }
      return value;
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }
    throw invalid(path, `expected a ${qualifiedName(resolved)} name`);
  }
  if (type === 'string') {
    if (typeof value !== 'string') throw invalid(path, 'string expected');
    return value;
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw invalid(path, 'boolean expected');
    return value;
  }
  if (type === 'bytes') {
    if (typeof value !== 'string') throw invalid(path, 'base64 string expected');
    return value;
  }
  if (INT64_TYPES.has(type)) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
    throw invalid(path, 'integer expected (a 64-bit value may be written as a string)');
  }
  if (INT32_TYPES.has(type)) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
    throw invalid(path, 'integer expected');
  }
  if (FLOAT_TYPES.has(type)) {
    if (typeof value === 'number') return value;
    if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') return Number(value);
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
    throw invalid(path, 'number expected');
  }
  return value;
}

/** Converts one JSON value into the parser's object form for `type`, checking every field name. */
function toParserObject(set: ProtoSet, type: protobuf.Type, value: unknown, path: string): unknown {
  const special = wellKnownFromJson(type, value, path, set);
  if (special !== undefined) {
    return special;
  }
  if (!isRecord(value)) {
    throw invalid(path, `expected a JSON object for ${qualifiedName(type)}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const field = fieldNamed(type, key);
    if (field === undefined) {
      throw invalid(`${path}.${key}`, `${qualifiedName(type)} has no field "${key}"`);
    }
    if (raw === null || raw === undefined) {
      continue;
    }
    field.resolve();
    const fieldPath = `${path}.${field.name}`;
    if (field instanceof protobuf.MapField) {
      if (!isRecord(raw)) throw invalid(fieldPath, 'a map field must be a JSON object');
      const valueType = field.resolvedType;
      out[field.name] = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [
          k,
          valueType instanceof protobuf.Type
            ? toParserObject(set, valueType, v, `${fieldPath}.${k}`)
            : checkScalar(field, v, `${fieldPath}.${k}`),
        ]),
      );
      continue;
    }
    const convert = (item: unknown, itemPath: string): unknown =>
      field.resolvedType instanceof protobuf.Type
        ? toParserObject(set, field.resolvedType, item, itemPath)
        : checkScalar(field, item, itemPath);
    if (field.repeated) {
      if (!Array.isArray(raw)) throw invalid(fieldPath, 'a repeated field must be a JSON array');
      out[field.name] = raw.map((item, index) => convert(item, `${fieldPath}[${String(index)}]`));
      continue;
    }
    out[field.name] = convert(raw, fieldPath);
  }
  return out;
}

/**
 * Encodes `json` as the binary form of the message type `typeName`.
 *
 * @throws ProtoError `grpc-message-invalid` naming the offending field, `proto-type-unknown`
 */
export function encodeMessage(set: ProtoSet, typeName: string, json: unknown): Uint8Array {
  const type = lookupMessageType(set, typeName);
  const object = toParserObject(set, type, json, qualifiedName(type)) as Record<string, unknown>;
  return type.encode(type.fromObject(object)).finish();
}

/** Message-level conversions for well-known types, parser form → JSON form. */
function wellKnownToJson(type: protobuf.Type, value: Record<string, unknown>, set: ProtoSet): unknown {
  const name = qualifiedName(type);
  const field = (id: number): string => type.fieldsById[id]?.name ?? String(id);
  const at = (id: number): unknown => value[field(id)];
  switch (name) {
    case 'google.protobuf.Timestamp':
      return timestampToJson({ seconds: at(1), nanos: at(2) });
    case 'google.protobuf.Duration':
      return durationToJson({ seconds: at(1), nanos: at(2) });
    case 'google.protobuf.FieldMask':
      return fieldMaskToJson({ paths: at(1) });
    case 'google.protobuf.Struct': {
      const fields = at(1);
      return isRecord(fields)
        ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, valueToJson(type.root, v)]))
        : {};
    }
    case 'google.protobuf.Value':
      return valueToJson(type.root, value);
    case 'google.protobuf.ListValue': {
      const items = at(1);
      return Array.isArray(items) ? items.map((item) => valueToJson(type.root, item)) : [];
    }
    case 'google.protobuf.Empty':
      return {};
    case 'google.protobuf.Any':
      return anyToJson(value, at(1), at(2), set);
    default:
      if (isWrapperType(name)) {
        return at(1) ?? wrapperDefault(name);
      }
      return undefined;
  }
}

function wrapperDefault(name: string): unknown {
  switch (name) {
    case 'google.protobuf.BoolValue':
      return false;
    case 'google.protobuf.StringValue':
    case 'google.protobuf.BytesValue':
      return '';
    case 'google.protobuf.Int64Value':
    case 'google.protobuf.UInt64Value':
      return '0';
    default:
      return 0;
  }
}

function valueToJson(root: protobuf.Root, value: unknown): unknown {
  if (!isRecord(value)) return null;
  const type = root.lookupType('google.protobuf.Value');
  const field = (id: number): string => type.fieldsById[id]?.name ?? String(id);
  if (field(2) in value) return value[field(2)];
  if (field(3) in value) return value[field(3)];
  if (field(4) in value) return value[field(4)];
  if (field(5) in value) {
    const struct = value[field(5)];
    const fields = isRecord(struct)
      ? struct[root.lookupType('google.protobuf.Struct').fieldsById[1]?.name ?? 'fields']
      : undefined;
    return isRecord(fields)
      ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, valueToJson(root, v)]))
      : {};
  }
  if (field(6) in value) {
    const list = value[field(6)];
    const items = isRecord(list)
      ? list[root.lookupType('google.protobuf.ListValue').fieldsById[1]?.name ?? 'values']
      : undefined;
    return Array.isArray(items) ? items.map((item) => valueToJson(root, item)) : [];
  }
  return null;
}

function anyToJson(value: Record<string, unknown>, typeUrl: unknown, bytes: unknown, set: ProtoSet): unknown {
  if (typeof typeUrl !== 'string' || typeUrl === '') {
    return value;
  }
  const innerName = typeUrl.slice(typeUrl.lastIndexOf('/') + 1);
  let inner: protobuf.Type;
  try {
    inner = lookupMessageType(set, innerName);
  } catch {
    return {
      '@type': typeUrl,
      value: typeof bytes === 'string' ? bytes : Buffer.from(bytes as Uint8Array).toString('base64'),
    };
  }
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'base64') : (bytes as Uint8Array);
  const decoded = decodeMessage(set, qualifiedName(inner), raw);
  return isRecord(decoded) && wellKnownToJson(inner, {}, set) === undefined
    ? { '@type': typeUrl, ...decoded }
    : { '@type': typeUrl, value: decoded };
}

/** Converts the parser's object form of `type` into canonical JSON. Lenient: nothing here throws. */
function toJson(set: ProtoSet, type: protobuf.Type, value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const special = wellKnownToJson(type, value, set);
  if (special !== undefined) {
    return special;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const field = type.fields[key];
    if (field === undefined) {
      out[key] = raw;
      continue;
    }
    field.resolve();
    const nested = field.resolvedType instanceof protobuf.Type ? field.resolvedType : undefined;
    if (field instanceof protobuf.MapField) {
      out[key] = isRecord(raw)
        ? Object.fromEntries(
            Object.entries(raw).map(([k, v]) => [k, nested === undefined ? v : toJson(set, nested, v)]),
          )
        : raw;
      continue;
    }
    if (field.repeated) {
      out[key] = Array.isArray(raw)
        ? (raw as unknown[]).map((item) => (nested === undefined ? item : toJson(set, nested, item)))
        : raw;
      continue;
    }
    out[key] = nested === undefined ? raw : toJson(set, nested, raw);
  }
  return out;
}

/**
 * Decodes `bytes` as the message type `typeName` into canonical JSON: 64-bit integers as strings,
 * enums by name, bytes as base64, well-known types in their string or bare forms, and fields at
 * their default value omitted.
 *
 * @throws ProtoError `grpc-message-malformed` when the bytes do not decode, `proto-type-unknown`
 */
export function decodeMessage(set: ProtoSet, typeName: string, bytes: Uint8Array): unknown {
  const type = lookupMessageType(set, typeName);
  let message: protobuf.Message;
  try {
    message = type.decode(bytes);
  } catch (error) {
    throw new ProtoError(
      'grpc-message-malformed',
      `The response could not be decoded as ${qualifiedName(type)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { type: qualifiedName(type), bytes: bytes.byteLength } },
    );
  }
  return toJson(set, type, type.toObject(message, TO_OBJECT_OPTIONS));
}

/**
 * Parses the JSON text of a request body into the messages to send: one object, or — for a
 * client-streaming method — an array of objects.
 *
 * @throws ProtoError `grpc-message-invalid` when the text is not JSON or has the wrong shape
 */
export function parseMessageText(text: string, streaming: boolean): unknown[] {
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch (error) {
    throw new ProtoError(
      'grpc-message-invalid',
      `The message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  if (streaming) {
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [parsed];
  }
  if (Array.isArray(parsed)) {
    throw new ProtoError('grpc-message-invalid', 'This method takes one message, but the body is a JSON array');
  }
  return [parsed];
}
