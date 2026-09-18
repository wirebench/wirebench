import type { GrpcMessageFieldWire } from '../../shared/wire-types.js';
import { ipc } from '../state/ipc-client.js';
import type { JsonCompletionSource } from './json-completion.js';

/**
 * A {@link JsonCompletionSource} backed by the `api.grpcFields` channel, for a message editor
 * opened on `type` of the gRPC API `apiId`.
 *
 * Answers are cached for the life of the source, keyed by path: the schema cannot change while the
 * editor is open, and a user typing inside one object asks about the same path on every keystroke.
 */
export function grpcFieldsSource(apiId: string, type: string): JsonCompletionSource {
  const cache = new Map<string, Promise<readonly GrpcMessageFieldWire[]>>();
  return {
    fetchFields(path) {
      const key = JSON.stringify(path);
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const pending = ipc()
        .api.grpcFields({ apiId, type, path: [...path] })
        .then((result) => (result.ok ? result.value.fields : []))
        // A failed lookup must not be remembered as "this message has no fields": drop it, so the
        // next keystroke asks again.
        .catch(() => {
          cache.delete(key);
          return [];
        });
      cache.set(key, pending);
      return pending;
    },
  };
}
