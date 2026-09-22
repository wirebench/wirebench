/**
 * AsyncAPI 2.x into the version-neutral view.
 *
 * In 2.x a channel's `publish` is what the described application accepts — so Wirebench, its peer,
 * sends it — and `subscribe` is what the application emits, which Wirebench receives.
 */

import type {
  AsyncApiChannel,
  AsyncApiDocument,
  AsyncApiMessage,
  AsyncApiOperation,
  AsyncApiServer,
  AsyncApiSkip,
} from './model.js';
import {
  channelParameter,
  deref,
  entries,
  isRecord,
  message,
  record,
  refKey,
  securityScheme,
  str,
  substitute,
  tagNames,
  type Json,
} from './read.js';

const DIRECTIONS = [
  ['publish', 'sent'],
  ['subscribe', 'received'],
] as const;

function payloadOf(node: Json): { payload?: unknown; schemaFormat?: string } {
  const schemaFormat = str(node['schemaFormat']);
  return {
    ...('payload' in node ? { payload: node['payload'] } : {}),
    ...(schemaFormat !== undefined ? { schemaFormat } : {}),
  };
}

/**
 * @param raw the parsed document before `$ref` inlining, where the keys references name still are
 * @param resolved the same document with references inlined
 */
export function normaliseAsyncApi2(raw: Json, resolved: Json, declaredVersion: string): AsyncApiDocument {
  const notes: AsyncApiSkip[] = [];
  const defaultContentType = str(resolved['defaultContentType']) ?? 'application/json';
  const schemes = record(record(resolved['components'])['securitySchemes']);

  const servers: AsyncApiServer[] = entries(resolved['servers']).map(([key, server]) => {
    const protocol = str(server['protocol']) ?? '';
    const written = str(server['url']) ?? '';
    const { value, unresolved } = substitute(written, server['variables']);
    const url = value.includes('://') || protocol === '' ? value : `${protocol}://${value}`;
    const security: readonly unknown[] = Array.isArray(server['security']) ? server['security'] : [];
    return {
      key,
      url,
      protocol,
      security: security.flatMap((requirement) =>
        Object.keys(record(requirement)).flatMap((name) => {
          const scheme = schemes[name];
          if (!isRecord(scheme)) {
            notes.push({ where: `servers/${key}/security`, reason: `no security scheme named ${name}` });
            return [];
          }
          return [securityScheme(name, scheme)];
        }),
      ),
      unresolvedVariables: unresolved,
    };
  });

  const channels: AsyncApiChannel[] = [];
  const operations: AsyncApiOperation[] = [];
  const rawChannels = record(raw['channels']);
  for (const [key, channel] of entries(resolved['channels'])) {
    const listed = channel['servers'];
    channels.push({
      key,
      address: key,
      servers:
        Array.isArray(listed) && listed.length > 0 ? listed.filter((s): s is string => typeof s === 'string') : 'all',
      parameters: Object.fromEntries(
        entries(channel['parameters']).map(([name, parameter]) => [
          name,
          channelParameter(record(parameter['schema'])),
        ]),
      ),
      bindings: record(channel['bindings']),
      tags: tagNames(channel['tags']),
    });

    const rawChannel = record(deref(raw, rawChannels[key]));
    for (const [verb, direction] of DIRECTIONS) {
      const operation = channel[verb];
      if (operation === undefined) continue;
      const where = `channels/${key}/${verb}`;
      if (!isRecord(operation)) {
        notes.push({ where, reason: 'the operation is not an object' });
        continue;
      }
      const opKey = str(operation['operationId']) ?? `${key}#${verb}`;
      const rawMessage = record(deref(raw, rawChannel[verb]))['message'];
      const messages = messagesOf(raw, rawMessage, operation['message'], opKey, defaultContentType);
      if (messages.length === 0) {
        notes.push({ where, reason: 'the operation names no message' });
      }
      operations.push({ key: opKey, channel: key, direction, messages });
    }
  }

  return {
    version: '2',
    declaredVersion,
    title: str(record(resolved['info'])['title']) ?? '',
    servers,
    channels,
    operations,
    notes,
  };
}

function messagesOf(
  raw: Json,
  rawNode: unknown,
  node: unknown,
  opKey: string,
  defaultContentType: string,
): AsyncApiMessage[] {
  if (!isRecord(node)) return [];
  const one = (rawOne: unknown, value: unknown, index: number): AsyncApiMessage[] => {
    if (!isRecord(value)) return [];
    const key = refKey(rawOne) ?? str(value['messageId']) ?? str(value['name']) ?? `${opKey}#message${String(index)}`;
    return [message(key, value, defaultContentType, payloadOf)];
  };
  const oneOf = node['oneOf'];
  if (Array.isArray(oneOf)) {
    const rawOneOf = record(deref(raw, rawNode))['oneOf'];
    return oneOf.flatMap((value, index) => one(Array.isArray(rawOneOf) ? rawOneOf[index] : undefined, value, index));
  }
  return one(rawNode, node, 0);
}
