/**
 * Reading a {@link ProtoSet} back as plain, serialisable descriptions: the services and methods an
 * import turns into folders and requests, and the shape of a message the editor's Form view and
 * sample generator work from. Nothing here holds a parser object, so the result crosses IPC as it is.
 */

import protobuf from 'protobufjs';
import { ProtoError } from '../../errors.js';
import type { GrpcMethodKind } from '../model.js';
import type { ProtoSet } from './load.js';
import { WELL_KNOWN_TYPES } from './well-known.js';

/** One method of a service, as declared. */
export interface GrpcMethodDescriptor {
  readonly name: string;
  readonly service: string;
  readonly kind: GrpcMethodKind;
  /** Fully qualified request and response message types, without a leading dot. */
  readonly requestType: string;
  readonly responseType: string;
  readonly comment?: string;
  readonly deprecated?: boolean;
}

/** One service, with its methods in declaration order. */
export interface GrpcServiceDescriptor {
  /** The short name, e.g. `Greeter`. */
  readonly name: string;
  /** The fully qualified name, e.g. `helloworld.Greeter`. */
  readonly fullName: string;
  /** The enclosing package, empty when the file declares none. */
  readonly package: string;
  readonly comment?: string;
  readonly methods: readonly GrpcMethodDescriptor[];
}

/** What kind of value a field holds. */
export type FieldValueKind = 'scalar' | 'enum' | 'message' | 'map';

/** One field of a message. */
export interface MessageFieldDescriptor {
  readonly name: string;
  readonly id: number;
  /** The declared type: a scalar name, or a fully qualified message or enum name. */
  readonly type: string;
  readonly valueKind: FieldValueKind;
  readonly repeated: boolean;
  /** Declared with the `optional` keyword (proto3 explicit presence, or any proto2 optional field). */
  readonly optional: boolean;
  /** The `oneof` this field belongs to, when it does. */
  readonly oneof?: string;
  /** For a map field: the key's scalar type. */
  readonly mapKeyType?: string;
  /** For an enum field: the value names, in declaration order. */
  readonly enumValues?: readonly string[];
  readonly comment?: string;
}

/** A message type, flattened for a reader that does not hold the parser's objects. */
export interface MessageDescriptor {
  readonly fullName: string;
  readonly fields: readonly MessageFieldDescriptor[];
  readonly oneofs: readonly string[];
}

function methodKindOf(method: protobuf.Method): GrpcMethodKind {
  if (method.requestStream === true && method.responseStream === true) {
    return 'bidi-streaming';
  }
  if (method.requestStream === true) {
    return 'client-streaming';
  }
  if (method.responseStream === true) {
    return 'server-streaming';
  }
  return 'unary';
}

/** A reflection object's fully qualified name without the leading dot protobufjs adds. */
export function qualifiedName(object: protobuf.ReflectionObject): string {
  return object.fullName.replace(/^\./, '');
}

function commentOf(object: { readonly comment: string | null }): { comment?: string } {
  const text = object.comment?.trim();
  return text !== undefined && text.length > 0 ? { comment: text } : {};
}

function walkServices(namespace: protobuf.NamespaceBase, out: protobuf.Service[]): void {
  for (const nested of namespace.nestedArray) {
    if (nested instanceof protobuf.Service) {
      out.push(nested);
    } else if (nested instanceof protobuf.Namespace) {
      walkServices(nested, out);
    }
  }
}

/** Every service in the set, in file and declaration order. */
export function describeServices(set: ProtoSet): GrpcServiceDescriptor[] {
  const services: protobuf.Service[] = [];
  walkServices(set.root, services);
  return services.map((service) => {
    const fullName = qualifiedName(service);
    const packageName = fullName.slice(0, Math.max(0, fullName.length - service.name.length - 1));
    return {
      name: service.name,
      fullName,
      package: packageName,
      ...commentOf(service),
      methods: service.methodsArray.map((method) => {
        method.resolve();
        return {
          name: method.name,
          service: fullName,
          kind: methodKindOf(method),
          requestType:
            method.resolvedRequestType !== null ? qualifiedName(method.resolvedRequestType) : method.requestType,
          responseType:
            method.resolvedResponseType !== null ? qualifiedName(method.resolvedResponseType) : method.responseType,
          ...commentOf(method),
          ...(method.getOption('deprecated') === true ? { deprecated: true } : {}),
        };
      }),
    };
  });
}

/**
 * The message type `fullName` names.
 *
 * @throws ProtoError `proto-type-unknown` when the set has no such message
 */
export function lookupMessageType(set: ProtoSet, fullName: string): protobuf.Type {
  const found = set.root.lookup(fullName.replace(/^\./, ''), protobuf.Type, true);
  if (found === null || !(found instanceof protobuf.Type)) {
    throw new ProtoError('proto-type-unknown', `Message type "${fullName}" is not defined by the loaded .proto files`, {
      details: { type: fullName },
    });
  }
  return found;
}

/**
 * The method `service`/`method` names, resolved.
 *
 * @throws ProtoError `proto-method-unknown` when the set has no such service or method
 */
export function lookupMethod(set: ProtoSet, service: string, method: string): protobuf.Method {
  const found = set.root.lookup(service.replace(/^\./, ''), protobuf.Service, true);
  if (found === null || !(found instanceof protobuf.Service)) {
    throw new ProtoError('proto-method-unknown', `Service "${service}" is not defined by the loaded .proto files`, {
      details: { service, method },
    });
  }
  const resolved = found.methods[method];
  if (resolved === undefined) {
    throw new ProtoError('proto-method-unknown', `Service "${service}" has no method "${method}"`, {
      details: { service, method },
    });
  }
  resolved.resolve();
  return resolved;
}

/** The request and response message types of one method, plus its streaming shape. */
export function describeMethod(set: ProtoSet, service: string, method: string): GrpcMethodDescriptor {
  const resolved = lookupMethod(set, service, method);
  return {
    name: resolved.name,
    service: service.replace(/^\./, ''),
    kind: methodKindOf(resolved),
    requestType:
      resolved.resolvedRequestType !== null ? qualifiedName(resolved.resolvedRequestType) : resolved.requestType,
    responseType:
      resolved.resolvedResponseType !== null ? qualifiedName(resolved.resolvedResponseType) : resolved.responseType,
    ...commentOf(resolved),
  };
}

function describeField(field: protobuf.Field): MessageFieldDescriptor {
  field.resolve();
  const map = field instanceof protobuf.MapField ? field : undefined;
  const resolvedType = field.resolvedType;
  const valueKind: FieldValueKind =
    map !== undefined
      ? 'map'
      : resolvedType instanceof protobuf.Enum
        ? 'enum'
        : resolvedType instanceof protobuf.Type
          ? 'message'
          : 'scalar';
  const type = resolvedType !== null ? qualifiedName(resolvedType) : field.type;
  return {
    name: field.name,
    id: field.id,
    type,
    valueKind,
    repeated: field.repeated,
    optional: (field.partOf?.name.startsWith('_') ?? false) || field.rule === 'optional',
    ...(field.partOf !== null && !field.partOf.name.startsWith('_') ? { oneof: field.partOf.name } : {}),
    ...(map !== undefined ? { mapKeyType: map.keyType } : {}),
    ...(resolvedType instanceof protobuf.Enum ? { enumValues: Object.keys(resolvedType.values) } : {}),
    ...commentOf(field),
  };
}

/** The fields of the message type `fullName`, in field-number order. */
export function describeMessage(set: ProtoSet, fullName: string): MessageDescriptor {
  const type = lookupMessageType(set, fullName);
  return {
    fullName: qualifiedName(type),
    fields: type.fieldsArray.map(describeField),
    oneofs: type.oneofsArray.filter((oneof) => !oneof.name.startsWith('_')).map((oneof) => oneof.name),
  };
}

/** The lowerCamelCase JSON name protobuf's JSON mapping accepts alongside a field's declared name. */
function jsonNameOf(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/** The message type `fullName`, or `undefined` when the set has no such message. */
function messageOrUndefined(set: ProtoSet, fullName: string): protobuf.Type | undefined {
  const found = set.root.lookup(fullName.replace(/^\./, ''), protobuf.Type, true);
  return found instanceof protobuf.Type ? found : undefined;
}

/** The field of `descriptor` a JSON key names, matching either the declared name or its JSON name. */
function fieldNamed(descriptor: MessageDescriptor, key: string): MessageFieldDescriptor | undefined {
  return descriptor.fields.find((field) => field.name === key || jsonNameOf(field.name) === key);
}

/**
 * The message whose fields belong at `path` — a chain of JSON object keys — under `rootType`.
 *
 * `path` is what {@link jsonCompletionContextAt} reports, so it carries no array indices: a
 * repeated field is descended through as if it were singular. A map field is followed by the
 * user's own key, which is consumed here, since only the schema knows that a level of the
 * document is a map rather than a nested message.
 *
 * Returns `undefined` when the path names a field the message does not have, stops on a scalar or
 * an enum, or ends on a map whose entries the user names — and for a well-known type, whose JSON
 * is its own mapping (a `Timestamp` is a string, a wrapper is a bare value) rather than its
 * fields, so offering those fields would be offering a document protobuf will not read back.
 *
 * @throws ProtoError `proto-type-unknown` when the set has no `rootType`
 */
export function describeMessageAt(
  set: ProtoSet,
  rootType: string,
  path: readonly string[],
): MessageDescriptor | undefined {
  let descriptor = describeMessage(set, rootType);
  let index = 0;
  while (index < path.length) {
    const field = fieldNamed(descriptor, path[index] as string);
    if (field === undefined) {
      return undefined;
    }
    if (field.valueKind === 'map') {
      // The next segment is whatever the user called this entry; the fields under it are the
      // value type's, so a map costs two segments rather than one.
      index += 1;
      if (index >= path.length) {
        return undefined;
      }
    } else if (field.valueKind !== 'message') {
      return undefined;
    }
    if (WELL_KNOWN_TYPES.has(field.type)) {
      return undefined;
    }
    const nested = messageOrUndefined(set, field.type);
    if (nested === undefined) {
      return undefined;
    }
    descriptor = describeMessage(set, field.type);
    index += 1;
  }
  return descriptor;
}
