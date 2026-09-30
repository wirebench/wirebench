/**
 * A gRPC request's script types, from its method's messages (spec §Types, gRPC).
 *
 * The types describe the messages' JSON form as the engine reads and writes it (`grpc/codec.ts`):
 * fields under their declared names, 64-bit integers and bytes as strings (bytes in base64), enums
 * by name, and every field optional, since a field left at its default is not written. Each message
 * type becomes one alias, so a recursive message is fine. The well-known types map to their JSON
 * forms.
 */
import { describeMessage, describeMethod, type MessageFieldDescriptor } from './proto/describe.js';
import type { ProtoSet } from './proto/load.js';
import { propertyKey } from '../script/types/json-schema.js';

const SCALARS: Readonly<Record<string, string>> = {
  double: 'number',
  float: 'number',
  int32: 'number',
  uint32: 'number',
  sint32: 'number',
  fixed32: 'number',
  sfixed32: 'number',
  int64: 'string',
  uint64: 'string',
  sint64: 'string',
  fixed64: 'string',
  sfixed64: 'string',
  bool: 'boolean',
  string: 'string',
  bytes: 'string',
};

const WELL_KNOWN: Readonly<Record<string, string>> = {
  'google.protobuf.Timestamp': 'string',
  'google.protobuf.Duration': 'string',
  'google.protobuf.FieldMask': 'string',
  'google.protobuf.Empty': 'Record<string, never>',
  'google.protobuf.Struct': 'Record<string, unknown>',
  'google.protobuf.Value': 'unknown',
  'google.protobuf.ListValue': 'unknown[]',
  'google.protobuf.Any': '{ "@type": string; [key: string]: unknown }',
  'google.protobuf.DoubleValue': 'number',
  'google.protobuf.FloatValue': 'number',
  'google.protobuf.Int32Value': 'number',
  'google.protobuf.UInt32Value': 'number',
  'google.protobuf.Int64Value': 'string',
  'google.protobuf.UInt64Value': 'string',
  'google.protobuf.BoolValue': 'boolean',
  'google.protobuf.StringValue': 'string',
  'google.protobuf.BytesValue': 'string',
};

/** At most this many message types become aliases; beyond them a message is `unknown`. */
const MAX_MESSAGES = 500;

function aliasOf(fullName: string): string {
  return `WbMsg_${fullName.replace(/^\./, '').replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function comment(text: string | undefined, indent: string): string {
  if (text === undefined || text.trim() === '') return '';
  return `${indent}/** ${text.trim().replace(/\*\//g, '*\\/').split(/\r?\n/).join(`\n${indent} * `)} */\n`;
}

class ProtoTypes {
  private readonly declared = new Map<string, string>();

  constructor(private readonly set: ProtoSet) {}

  message(fullName: string): string {
    const name = fullName.replace(/^\./, '');
    const known = WELL_KNOWN[name];
    if (known !== undefined) return known;
    const alias = aliasOf(name);
    if (this.declared.has(alias)) return alias;
    if (this.declared.size >= MAX_MESSAGES) return 'unknown';
    // Reserved first, so a message that refers to itself refers to the alias.
    this.declared.set(alias, '');
    let descriptor;
    try {
      descriptor = describeMessage(this.set, name);
    } catch {
      this.declared.set(alias, `type ${alias} = unknown;\n`);
      return alias;
    }
    const fields = descriptor.fields.map(
      (field) => `${comment(field.comment, '  ')}  ${propertyKey(field.name)}?: ${this.field(field)};\n`,
    );
    this.declared.set(
      alias,
      `/** ${name} */\ntype ${alias} = ${fields.length === 0 ? 'Record<string, never>' : `{\n${fields.join('')}}`};\n`,
    );
    return alias;
  }

  private value(field: MessageFieldDescriptor): string {
    switch (field.valueKind) {
      case 'scalar':
        return SCALARS[field.type] ?? 'unknown';
      case 'enum':
        return field.enumValues !== undefined && field.enumValues.length > 0
          ? field.enumValues.map((v) => JSON.stringify(v)).join(' | ')
          : 'string';
      case 'message':
      case 'map':
        if (field.enumValues !== undefined && field.enumValues.length > 0) {
          return field.enumValues.map((v) => JSON.stringify(v)).join(' | ');
        }
        return SCALARS[field.type] ?? this.message(field.type);
    }
  }

  private field(field: MessageFieldDescriptor): string {
    const value = this.value(field);
    if (field.valueKind === 'map') {
      return `Record<string, ${value}>`;
    }
    if (field.repeated) {
      return /^[A-Za-z0-9_$]+$/.test(value) ? `${value}[]` : `(${value})[]`;
    }
    return value;
  }

  declarations(): string {
    return [...this.declared.values()].join('');
  }
}

/** `WbRequestMessage` and `WbResponseMessage` for a method's input and output types. */
export function grpcScriptTypes(set: ProtoSet | undefined, inputType: string, outputType: string): string {
  if (set === undefined) {
    return [
      "// This request's proto definition is not at hand, so its messages are untyped.",
      'type WbRequestMessage = unknown;',
      'type WbResponseMessage = unknown;',
      '',
    ].join('\n');
  }
  const types = new ProtoTypes(set);
  const request = types.message(inputType);
  const response = types.message(outputType);
  return [
    types.declarations(),
    `type WbRequestMessage = ${request};`,
    `type WbResponseMessage = ${response};`,
    '',
  ].join('\n');
}

/** A gRPC method's request and response message types, when the set has the method. */
export function grpcMessageTypes(
  set: ProtoSet | undefined,
  service: string,
  method: string,
): { readonly input: string; readonly output: string } | undefined {
  if (set === undefined) return undefined;
  try {
    const described = describeMethod(set, service, method);
    return { input: described.requestType, output: described.responseType };
  } catch {
    return undefined;
  }
}
