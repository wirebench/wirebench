import { collectNamespaces, evaluateWithTimeout, suggestPrefixes } from '@wirebench/engine';
import type { QueryResult } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { ChannelResponse } from '../../shared/ipc.js';
import { registerHandler } from './register.js';

/** Spreads the engine's `readonly`-everywhere `QueryResult` into the plain mutable shape the
 * `xpath.evaluate` wire schema (a `z.infer`) expects — the two are structurally identical, only
 * `readonly` differs, but the response schema still has to validate/serialise a real object. */
function toWire(result: QueryResult): ChannelResponse<typeof channels.xpath.evaluate> {
  if (result.kind === 'nodes') {
    return { kind: 'nodes', items: result.items.map((item) => ({ ...item })), truncated: result.truncated };
  }
  if (result.kind === 'values') {
    return { kind: 'values', items: result.items.map((item) => ({ ...item })), truncated: result.truncated };
  }
  return result;
}

/**
 * Registers the `xpath.*` IPC channels backing the response Query view: evaluating an
 * XPath 3.1 / XQuery 3.1 / JSONPath expression — over an envelope or over a JSON body — and
 * discovering the namespaces a document already binds. Both are pure engine calls (no
 * project/interface state), but `fontoxpath` and `jsonpath-plus` stay out of the renderer bundle by
 * running here instead.
 */
export function registerXpathChannels(): void {
  registerHandler(channels.xpath.evaluate, async (request) => {
    const result = await evaluateWithTimeout(
      request.xml,
      request.expression,
      {
        language: request.language,
        ...(request.namespaces !== undefined ? { namespaces: request.namespaces } : {}),
      },
      request.kind !== undefined ? { kind: request.kind } : {},
    );
    return toWire(result);
  });

  registerHandler(channels.xpath.namespaces, (request) => {
    const namespaces = collectNamespaces(request.xml);
    const suggestions = suggestPrefixes(request.xml);
    return Promise.resolve({ namespaces, suggestions });
  });
}
