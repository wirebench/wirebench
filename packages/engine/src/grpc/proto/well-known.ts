/**
 * The JSON mapping the protobuf specification gives the well-known types: a `Timestamp` is an
 * RFC 3339 string, a `Duration` is `"1.5s"`, a `Struct` is the JSON object it represents, a wrapper
 * is its bare value, an `Any` carries an `@type` beside the message's own fields. The parser
 * itself knows only the field-by-field form (`{seconds, nanos}`), so the codec converts between
 * the two here, on the way in and on the way out, field numbers rather than names because the
 * bundled definitions do not spell the names the way a `.proto` on disk does.
 */

import { ProtoError } from '../../errors.js';

/** The fully qualified names this module handles. */
export const WELL_KNOWN_TYPES: ReadonlySet<string> = new Set([
  'google.protobuf.Timestamp',
  'google.protobuf.Duration',
  'google.protobuf.Struct',
  'google.protobuf.Value',
  'google.protobuf.ListValue',
  'google.protobuf.NullValue',
  'google.protobuf.Empty',
  'google.protobuf.FieldMask',
  'google.protobuf.Any',
  'google.protobuf.DoubleValue',
  'google.protobuf.FloatValue',
  'google.protobuf.Int64Value',
  'google.protobuf.UInt64Value',
  'google.protobuf.Int32Value',
  'google.protobuf.UInt32Value',
  'google.protobuf.BoolValue',
  'google.protobuf.StringValue',
  'google.protobuf.BytesValue',
]);

const WRAPPERS: ReadonlySet<string> = new Set(
  [...WELL_KNOWN_TYPES].filter(
    (name) =>
      name.endsWith('Value') &&
      name !== 'google.protobuf.Value' &&
      name !== 'google.protobuf.ListValue' &&
      name !== 'google.protobuf.NullValue',
  ),
);

/** Whether `fullName` is a wrapper type (`google.protobuf.StringValue` and its siblings). */
export function isWrapperType(fullName: string): boolean {
  return WRAPPERS.has(fullName);
}

/** The sample the editor shows for a well-known type, or `undefined` for an ordinary message. */
export function wellKnownSample(fullName: string): unknown {
  switch (fullName) {
    case 'google.protobuf.Timestamp':
      return '1970-01-01T00:00:00Z';
    case 'google.protobuf.Duration':
      return '0s';
    case 'google.protobuf.Struct':
    case 'google.protobuf.Empty':
      return {};
    case 'google.protobuf.Value':
      return null;
    case 'google.protobuf.ListValue':
      return [];
    case 'google.protobuf.FieldMask':
      return '';
    case 'google.protobuf.Any':
      return { '@type': '' };
    case 'google.protobuf.BoolValue':
      return false;
    case 'google.protobuf.StringValue':
    case 'google.protobuf.BytesValue':
    case 'google.protobuf.Int64Value':
    case 'google.protobuf.UInt64Value':
      return '';
    case 'google.protobuf.DoubleValue':
    case 'google.protobuf.FloatValue':
    case 'google.protobuf.Int32Value':
    case 'google.protobuf.UInt32Value':
      return 0;
    default:
      return undefined;
  }
}

function invalid(type: string, reason: string): ProtoError {
  return new ProtoError('grpc-message-invalid', `${type}: ${reason}`, { details: { type, reason } });
}

/** `{seconds, nanos}` from a JSON `Timestamp` string. */
export function timestampFromJson(value: unknown): { seconds: string; nanos: number } {
  if (typeof value !== 'string') {
    throw invalid('google.protobuf.Timestamp', 'expected an RFC 3339 string');
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) {
    throw invalid('google.protobuf.Timestamp', `"${value}" is not an RFC 3339 timestamp`);
  }
  const millis = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(millis)) {
    throw invalid('google.protobuf.Timestamp', `"${value}" is not a valid date`);
  }
  const fraction = match[2] === undefined ? '' : match[2].slice(1).padEnd(9, '0');
  return { seconds: String(Math.floor(millis / 1000)), nanos: fraction === '' ? 0 : Number(fraction) };
}

/** A JSON `Timestamp` string from `{seconds, nanos}`. */
export function timestampToJson(value: { seconds?: unknown; nanos?: unknown }): string {
  const seconds = Number(value.seconds ?? 0);
  const nanos = Number(value.nanos ?? 0);
  const iso = new Date(seconds * 1000).toISOString().slice(0, 19);
  if (nanos === 0) {
    return `${iso}Z`;
  }
  const fraction = String(nanos)
    .padStart(9, '0')
    .replace(/(?:000)+$/, '');
  return `${iso}.${fraction}Z`;
}

/** `{seconds, nanos}` from a JSON `Duration` string such as `"1.5s"`. */
export function durationFromJson(value: unknown): { seconds: string; nanos: number } {
  if (typeof value !== 'string') {
    throw invalid('google.protobuf.Duration', 'expected a string such as "1.5s"');
  }
  const match = /^(-)?(\d+)(?:\.(\d{1,9}))?s$/.exec(value);
  if (match === null) {
    throw invalid('google.protobuf.Duration', `"${value}" is not a duration such as "1.5s"`);
  }
  const negative = match[1] === '-';
  const seconds = BigInt(match[2] ?? '0');
  const nanos = match[3] === undefined ? 0 : Number(match[3].padEnd(9, '0'));
  return { seconds: `${negative ? '-' : ''}${seconds.toString()}`, nanos: negative ? -nanos : nanos };
}

/** A JSON `Duration` string from `{seconds, nanos}`. */
export function durationToJson(value: { seconds?: unknown; nanos?: unknown }): string {
  const seconds = typeof value.seconds === 'string' || typeof value.seconds === 'number' ? String(value.seconds) : '0';
  const nanos = Number(value.nanos ?? 0);
  const negative = seconds.startsWith('-') || nanos < 0;
  const absSeconds = seconds.replace(/^-/, '');
  const absNanos = Math.abs(nanos);
  const fraction =
    absNanos === 0
      ? ''
      : `.${String(absNanos)
          .padStart(9, '0')
          .replace(/(?:000)+$/, '')}`;
  return `${negative ? '-' : ''}${absSeconds}${fraction}s`;
}

/** A JSON `FieldMask` string (`"a.b,c"`) as `{paths}`. */
export function fieldMaskFromJson(value: unknown): { paths: string[] } {
  if (typeof value !== 'string') {
    throw invalid('google.protobuf.FieldMask', 'expected a comma-separated string of paths');
  }
  return { paths: value === '' ? [] : value.split(',').map((path) => path.trim()) };
}

/** `{paths}` as the JSON `FieldMask` string. */
export function fieldMaskToJson(value: { paths?: unknown }): string {
  return Array.isArray(value.paths) ? value.paths.map(String).join(',') : '';
}
