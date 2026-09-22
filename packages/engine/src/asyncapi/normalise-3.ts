/**
 * AsyncAPI 3.0 into the version-neutral view.
 *
 * A 3.0 operation's `action` is the described application's: `receive` is what it accepts, so
 * Wirebench — its peer — sends it, and `send` is what it emits, which Wirebench receives. A `reply`
 * travels the other way from its operation.
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
  isJsonSchemaFormat,
  isRecord,
  localRef,
  message,
  record,
  refKey,
  securityScheme,
  str,
  substitute,
  tagNames,
  type Json,
} from './read.js';

type Direction = AsyncApiOperation['direction'];

function payloadOf(node: Json): { payload?: unknown; schemaFormat?: string } {
  const payload = node['payload'];
  // A multi-format schema object carries its format beside the schema.
  if (isRecord(payload) && 'schema' in payload && typeof payload['schemaFormat'] === 'string') {
    return { payload: payload['schema'], schemaFormat: payload['schemaFormat'] };
  }
  return payload !== undefined ? { payload } : {};
}

/** The channel key a raw `{ $ref: '#/channels/<key>' }` names. */
function channelKey(rawNode: unknown): string | undefined {
  const tokens = localRef(rawNode);
  return tokens?.length === 2 && tokens[0] === 'channels' ? tokens[1] : undefined;
}

/**
 * @param raw the parsed document before `$ref` inlining, where the keys references name still are
 * @param resolved the same document with references inlined
 */
export function normaliseAsyncApi3(raw: Json, resolved: Json, declaredVersion: string): AsyncApiDocument {
  const notes: AsyncApiSkip[] = [];
  const defaultContentType = str(resolved['defaultContentType']) ?? 'application/json';
  const rawServers = record(raw['servers']);

  const servers: AsyncApiServer[] = entries(resolved['servers']).map(([key, server]) => {
    const protocol = str(server['protocol']) ?? '';
    const written = `${str(server['host']) ?? ''}${str(server['pathname']) ?? ''}`;
    const { value, unresolved } = substitute(written, server['variables']);
    const rawSecurity = record(deref(raw, rawServers[key]))['security'];
    const security: readonly unknown[] = Array.isArray(server['security']) ? server['security'] : [];
    return {
      key,
      url: protocol === '' ? value : `${protocol}://${value}`,
      protocol,
      security: security.flatMap((scheme, index) => {
        if (!isRecord(scheme)) return [];
        const rawOne: unknown = Array.isArray(rawSecurity) ? rawSecurity[index] : undefined;
        return [securityScheme(refKey(rawOne) ?? `${key}#security${String(index)}`, scheme)];
      }),
      unresolvedVariables: unresolved,
    };
  });

  const rawChannels = record(raw['channels']);
  const channelMessages = new Map<string, AsyncApiMessage[]>();
  const channels: AsyncApiChannel[] = entries(resolved['channels']).map(([key, channel]) => {
    channelMessages.set(
      key,
      entries(channel['messages']).map(([messageKey, node]) => {
        const read = message(messageKey, node, defaultContentType, payloadOf, false);
        if (!isJsonSchemaFormat(read.schemaFormat)) {
          notes.push({
            where: `channels/${key}/messages/${messageKey}`,
            reason: `the payload uses ${String(read.schemaFormat)}, which is not JSON Schema`,
          });
        }
        return read;
      }),
    );
    const rawListed = record(deref(raw, rawChannels[key]))['servers'];
    const listed = Array.isArray(rawListed)
      ? rawListed.map((node) => refKey(node)).filter((k): k is string => k !== undefined)
      : [];
    return {
      key,
      address: str(channel['address']) ?? null,
      servers: listed.length > 0 ? listed : 'all',
      parameters: Object.fromEntries(
        entries(channel['parameters']).map(([name, parameter]) => [name, channelParameter(parameter)]),
      ),
      bindings: record(channel['bindings']),
      tags: tagNames(channel['tags']),
    };
  });

  /** The messages a raw list of `#/channels/<c>/messages/<m>` refs names, else the channel's all. */
  const pick = (channel: string, rawList: unknown, where: string): AsyncApiMessage[] => {
    const all = channelMessages.get(channel) ?? [];
    if (!Array.isArray(rawList)) return all;
    return rawList.flatMap((node) => {
      const key = refKey(node);
      const found = all.find((m) => m.key === key);
      if (found === undefined) {
        notes.push({ where, reason: `the message ${key ?? 'written inline'} is not one of channel ${channel}'s` });
        return [];
      }
      return [found];
    });
  };

  const operations: AsyncApiOperation[] = [];
  const rawOperations = record(raw['operations']);
  for (const [key] of entries(resolved['operations'])) {
    const where = `operations/${key}`;
    const rawOperation = record(deref(raw, rawOperations[key]));
    const action = rawOperation['action'];
    const direction: Direction | undefined = action === 'receive' ? 'sent' : action === 'send' ? 'received' : undefined;
    if (direction === undefined) {
      notes.push({ where, reason: `the action ${String(action)} is neither send nor receive` });
      continue;
    }
    const channel = channelKey(rawOperation['channel']);
    if (channel === undefined || !channelMessages.has(channel)) {
      notes.push({ where, reason: 'the operation does not reference a channel of this document' });
      continue;
    }
    operations.push({ key, channel, direction, messages: pick(channel, rawOperation['messages'], where) });

    const rawReply = deref(raw, rawOperation['reply']);
    if (isRecord(rawReply)) {
      if (rawReply['channel'] === undefined && rawReply['address'] !== undefined) {
        notes.push({
          where: `${where}/reply`,
          reason: "the reply's address is set at run time; it is mapped onto the operation's channel",
        });
      }
      const replyChannel = channelKey(rawReply['channel']) ?? channel;
      operations.push({
        key: `${key}#reply`,
        channel: replyChannel,
        direction: direction === 'sent' ? 'received' : 'sent',
        messages: pick(replyChannel, rawReply['messages'], `${where}/reply`),
      });
    }
  }

  return {
    version: '3',
    declaredVersion,
    title: str(record(resolved['info'])['title']) ?? '',
    servers,
    channels,
    operations,
    notes,
  };
}
