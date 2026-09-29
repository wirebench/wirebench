/**
 * Checks what a pre-request script changed before any of it is sent (spec §What a pre-request
 * script can change; ADR-0016).
 *
 * The request a script hands back is untrusted input: a script can call `__finish` itself and
 * return any shape. So it is parsed against a schema first, then held to the rules:
 *
 * - the scheme, host and port stay what they were (`script-origin-change`), and a gRPC method stays
 *   the one the request calls;
 * - no header, metadata, URL or SOAPAction holds CR, LF or NUL (`script-value-invalid`);
 * - a body the script cannot edit (form, multipart, binary) comes back unchanged;
 * - no `${secret:…}` reference appears that the request's own text did not already hold
 *   (`script-secret-denied`) — otherwise a script could read any secret by naming it.
 */
import { z } from 'zod';
import { urlOrigin } from '../project/sequence-guards.js';
import type { RequestSnapshot, ScriptFailure } from './model.js';

const pair = z.tuple([z.string(), z.string()]);

const restBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('text'), text: z.string(), language: z.string() }),
  z.object({ kind: z.literal('other'), description: z.string() }),
]);

const snapshotSchema = z.discriminatedUnion('protocol', [
  z.object({
    protocol: z.literal('rest'),
    method: z.string(),
    url: z.string(),
    headers: z.array(pair),
    body: restBody,
  }),
  z.object({
    protocol: z.literal('soap'),
    endpoint: z.string(),
    soapAction: z.string(),
    headers: z.array(pair),
    envelope: z.string(),
    body: z.unknown().optional(),
  }),
  z.object({
    protocol: z.literal('grpc'),
    target: z.string(),
    method: z.string(),
    metadata: z.array(pair),
    message: z.unknown(),
  }),
]);

export type ApplyResult =
  { readonly ok: true; readonly request: RequestSnapshot } | { readonly ok: false; readonly error: ScriptFailure };

const CONTROL = /[\r\n\0]/;
const METHOD = /^[A-Z][A-Z0-9_-]{0,31}$/;
const SECRET_OPEN = '${secret:';

const refuse = (code: ScriptFailure['code'], message: string): ApplyResult => ({ ok: false, error: { code, message } });

/** Every `${secret:name}` a request's text names. */
export function secretReferencesIn(request: RequestSnapshot): Set<string> {
  const texts: string[] = [];
  switch (request.protocol) {
    case 'rest':
      texts.push(request.method, request.url, ...request.headers.flat());
      if (request.body.kind === 'text') texts.push(request.body.text);
      break;
    case 'soap':
      texts.push(request.endpoint, request.soapAction, request.envelope, ...request.headers.flat());
      break;
    case 'grpc':
      texts.push(request.target, ...request.metadata.flat(), JSON.stringify(request.message) ?? '');
      break;
  }
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

function badPair(pairs: readonly (readonly [string, string])[]): string | undefined {
  return pairs.find(([name, value]) => CONTROL.test(name) || CONTROL.test(value))?.[0];
}

function sameOrigin(before: string, after: string): boolean {
  const was = urlOrigin(before);
  const now = urlOrigin(after);
  // A destination that was not a URL (a relative one resolved later) has to stay exactly as it was.
  return was === undefined ? before === after : was === now;
}

/** The checked request a pre-request script hands back, or why it is refused. */
export function applyRequestChanges(before: RequestSnapshot, returned: unknown): ApplyResult {
  const parsed = snapshotSchema.safeParse(returned);
  if (!parsed.success || parsed.data.protocol !== before.protocol) {
    return refuse('script-error', 'The script handed back a request the engine cannot read');
  }
  const after = parsed.data as RequestSnapshot;

  switch (after.protocol) {
    case 'rest': {
      const was = before as Extract<RequestSnapshot, { protocol: 'rest' }>;
      if (!METHOD.test(after.method)) {
        return refuse('script-value-invalid', `"${after.method}" is not an HTTP method`);
      }
      if (CONTROL.test(after.url)) {
        return refuse('script-value-invalid', 'The URL may not hold CR, LF or NUL');
      }
      if (!sameOrigin(was.url, after.url)) {
        return refuse('script-origin-change', 'A script cannot change the scheme, host or port of the request');
      }
      const header = badPair(after.headers);
      if (header !== undefined) {
        return refuse('script-value-invalid', `The header "${header}" may not hold CR, LF or NUL`);
      }
      if (was.body.kind === 'other' && JSON.stringify(after.body) !== JSON.stringify(was.body)) {
        return refuse('script-error', `A script cannot change a body that is ${was.body.description}`);
      }
      break;
    }
    case 'soap': {
      const was = before as Extract<RequestSnapshot, { protocol: 'soap' }>;
      if (CONTROL.test(after.endpoint) || CONTROL.test(after.soapAction)) {
        return refuse('script-value-invalid', 'The endpoint and SOAPAction may not hold CR, LF or NUL');
      }
      if (!sameOrigin(was.endpoint, after.endpoint)) {
        return refuse('script-origin-change', 'A script cannot change the scheme, host or port of the endpoint');
      }
      const header = badPair(after.headers);
      if (header !== undefined) {
        return refuse('script-value-invalid', `The header "${header}" may not hold CR, LF or NUL`);
      }
      break;
    }
    case 'grpc': {
      const was = before as Extract<RequestSnapshot, { protocol: 'grpc' }>;
      if (after.target !== was.target) {
        return refuse('script-origin-change', 'A script cannot change the target of a gRPC call');
      }
      if (after.method !== was.method) {
        return refuse('script-error', 'A script cannot change which gRPC method is called');
      }
      const entry = badPair(after.metadata);
      if (entry !== undefined) {
        return refuse('script-value-invalid', `The metadata "${entry}" may not hold CR, LF or NUL`);
      }
      break;
    }
  }

  const allowed = secretReferencesIn(before);
  const added = [...secretReferencesIn(after)].filter((name) => !allowed.has(name));
  if (added.length > 0) {
    return refuse(
      'script-secret-denied',
      `A script cannot add a reference to a secret the request does not already use: ${added.join(', ')}`,
    );
  }
  return { ok: true, request: after };
}
