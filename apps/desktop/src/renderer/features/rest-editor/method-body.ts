/**
 * The body a method change brings with it (G11): a request switched to POST, PUT or PATCH while it
 * has no body starts on Raw · JSON, ready to type into, instead of None and two more choices.
 *
 * Only a change *into* those methods from one that carries no body does it. A POST whose body the
 * user set to None, then changed to PUT, keeps None: that was a choice, not a default.
 */
import type { RestBodyWire } from '@shared/kinds/rest/wire.js';

const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** The body to stage with a change from `previous` to `next`, or `undefined` to leave the body as it is. */
export function bodyForMethodChange(previous: string, next: string, body: RestBodyWire): RestBodyWire | undefined {
  if (body.kind !== 'none') return undefined;
  if (BODY_METHODS.has(previous.toUpperCase()) || !BODY_METHODS.has(next.toUpperCase())) return undefined;
  return { kind: 'raw', language: 'json', text: '' };
}
