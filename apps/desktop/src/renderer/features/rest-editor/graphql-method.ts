/**
 * The method a body-kind switch implies.
 *
 * A GraphQL request is a POST: a GET or HEAD would carry no body (#77), so choosing GraphQL on one
 * moves it to POST. That change is remembered per request — the Body tab unmounts on every tab switch,
 * so it cannot live in component state — and leaving GraphQL puts the old method back, as long as the
 * user has not picked another method in between.
 */

/** The method each request had before GraphQL moved it to POST, by request id. */
const changedFrom = new Map<string, string>();

/** What a body-kind switch does to the method. */
export interface BodySwitchMethod {
  /** The method to stage with the new body, when it changes. */
  readonly method?: string;
  /** Set when GraphQL moved the method to POST: the method it replaced, for the Undo toast. */
  readonly autoChangedFrom?: string;
}

/**
 * The method to send with a body switching from `from` to `to`, on a request whose method is `method`.
 *
 * @param requestId the request, so a later switch away from GraphQL can restore its method
 */
export function methodForBodySwitch(requestId: string, from: string, to: string, method: string): BodySwitchMethod {
  if (to === 'graphql' && (method === 'GET' || method === 'HEAD')) {
    changedFrom.set(requestId, method);
    return { method: 'POST', autoChangedFrom: method };
  }
  if (from === 'graphql') {
    const previous = changedFrom.get(requestId);
    changedFrom.delete(requestId);
    // A method the user chose since is theirs; only the automatic POST is undone.
    if (previous !== undefined && method === 'POST') {
      return { method: previous };
    }
  }
  return {};
}

/** Forgets the automatic change, after Undo puts the old method back by hand. */
export function forgetGraphqlMethodChange(requestId: string): void {
  changedFrom.delete(requestId);
}
