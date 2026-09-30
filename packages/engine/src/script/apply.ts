/**
 * Checks what a pre-request script changed before any of it is sent (spec §What a pre-request
 * script can change; ADR-0016).
 *
 * The request a script hands back is untrusted input: a script can call `__finish` itself and
 * return any shape. So it is parsed against its protocol's schema first, then held to the rules.
 * The rules are the same for every protocol. A module says what its snapshot holds
 * (`ProtocolScripting.inspect`) and this file decides, so a module cannot forget a rule:
 *
 * 1. the value parses against the module's `requestSchema` and keeps its `protocol`
 *    (`script-error`);
 * 2. no single-line value holds CR, LF or NUL (`script-value-invalid`);
 * 3. the destination keeps its scheme, host and port, and one that is not a URL stays exactly as it
 *    was (`script-origin-change`);
 * 4. what the module calls fixed comes back unchanged (`script-error`);
 * 5. no header or metadata pair holds CR, LF or NUL (`script-value-invalid`);
 * 6. no `${secret:…}` reference appears that the request's own text did not already hold
 *    (`script-secret-denied`) — otherwise a script could read any secret by naming it;
 * 7. the module's own rules (`validate`), when it has any.
 *
 * The order is fixed for every protocol, so a request that breaks two rules at once is reported the
 * same way whatever its protocol. It is not quite the order of 2.x: REST used to check first that
 * the method is an HTTP method, and that check now runs last, in its `validate` (spec R5).
 */
import { z } from 'zod';
import type { ProtocolScripting, RequestSnapshotBase, ResponseSnapshotBase } from '../protocol/module.js';
import type { HeaderPair, ScriptFailure } from './model.js';

/** A header or metadata pair as a script hands it back; every module's `requestSchema` uses it. */
export const headerPairSchema = z.tuple([z.string(), z.string()]);

/** The checked request a pre-request script hands back, or why it is refused. */
export type ApplyResult<Q extends RequestSnapshotBase = RequestSnapshotBase> =
  { readonly ok: true; readonly request: Q } | { readonly ok: false; readonly error: ScriptFailure };

const CONTROL = /[\r\n\0]/;
const SECRET_OPEN = '${secret:';

const refuse = (
  code: ScriptFailure['code'],
  message: string,
): { readonly ok: false; readonly error: ScriptFailure } => ({ ok: false, error: { code, message } });

/** Every `${secret:name}` that `texts` name: a module's `inspect(snapshot).texts`. */
export function secretReferencesIn(texts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) {
    addSecretNames(text, names);
  }
  return names;
}

/**
 * Adds the name of every `${secret:name}` in `text` to `names`: the text from each `${secret:` to
 * the first `}` after it. A scan rather than a regex, so text a server chose — many `${secret:`
 * with no closing brace — costs linear time, never quadratic.
 */
function addSecretNames(text: string, names: Set<string>): void {
  let from = 0;
  for (;;) {
    const open = text.indexOf(SECRET_OPEN, from);
    if (open === -1) return;
    const start = open + SECRET_OPEN.length;
    const close = text.indexOf('}', start);
    // No `}` after this opening means none after any later one either.
    if (close === -1) return;
    names.add(text.slice(start, close));
    from = close + 1;
  }
}

function badPair(pairs: readonly HeaderPair[]): string | undefined {
  return pairs.find(([name, value]) => CONTROL.test(name) || CONTROL.test(value))?.[0];
}

/**
 * The origin of a destination that is a URL with a host; undefined for anything else. A gRPC
 * `host:port` target parses as a scheme and a path with no host, and so does `localhost:8080/x`:
 * neither has an origin a path could change under, so both have to stay exactly as they were.
 */
function originOf(destination: string): string | undefined {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return undefined;
  }
  if (url.host === '') return undefined;
  // A non-special scheme (`grpc:`) has an opaque `origin` of "null"; host and port still say where
  // the request goes.
  return url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`;
}

function sameDestination(before: string, after: string): boolean {
  const was = originOf(before);
  return was === undefined ? before === after : was === originOf(after);
}

/**
 * The checked request a pre-request script hands back, or why it is refused. `scripting` is the
 * facet of the protocol `before` belongs to.
 */
export function applyRequestChanges<Q extends RequestSnapshotBase, R extends ResponseSnapshotBase>(
  scripting: ProtocolScripting<Q, R>,
  before: Q,
  returned: unknown,
): ApplyResult<Q> {
  const parsed = scripting.requestSchema.safeParse(returned);
  if (!parsed.success || parsed.data.protocol !== before.protocol) {
    return refuse('script-error', 'The script handed back a request the engine cannot read');
  }
  const after = parsed.data;
  const was = scripting.inspect(before);
  const now = scripting.inspect(after);

  if (now.lines.some((line) => CONTROL.test(line))) {
    return refuse('script-value-invalid', 'A single-line value of the request may not hold CR, LF or NUL');
  }
  if (!sameDestination(was.destination, now.destination)) {
    return refuse('script-origin-change', 'A script cannot change the scheme, host or port the request is sent to');
  }
  if (JSON.stringify(now.fixed) !== JSON.stringify(was.fixed)) {
    return refuse('script-error', 'A script cannot change a part of the request that is fixed');
  }
  const pair = badPair(now.pairs);
  if (pair !== undefined) {
    return refuse('script-value-invalid', `The header or metadata entry "${pair}" may not hold CR, LF or NUL`);
  }
  const allowed = secretReferencesIn(was.texts);
  const added = [...secretReferencesIn(now.texts)].filter((name) => !allowed.has(name));
  if (added.length > 0) {
    return refuse(
      'script-secret-denied',
      `A script cannot add a reference to a secret the request does not already use: ${added.join(', ')}`,
    );
  }
  const failure = scripting.validate?.(before, after);
  if (failure !== undefined) {
    return { ok: false, error: failure };
  }
  return { ok: true, request: after };
}
