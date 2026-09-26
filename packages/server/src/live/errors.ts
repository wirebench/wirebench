/**
 * Every `live-*` code (live-updates spec §3.5, §10), spelled once. Neither reaches a user: the app
 * sends no `Origin` (assumption 4), and a refused subscription only leaves that workspace polling at
 * the user's interval.
 */
import type { LIVE_REFUSED_CODES, WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/**
 * §6: an upgrade whose `Origin` is present and is not `publicUrl`. It is answered before the upgrade,
 * so a web page open in a browser cannot listen in on a signed-in user's workspaces.
 */
export function liveOriginRefused(): WirebenchError {
  return problem('live-origin-refused', 'Live updates do not accept connections from another site.', 403);
}

/**
 * §3.1: the `refused` code for a session's 201st subscription. It is a socket message, not an HTTP
 * problem, so it is a constant. `satisfies` keeps it inside the wire union.
 */
export const LIVE_TOO_MANY_SUBSCRIPTIONS = 'live-too-many-subscriptions' satisfies (typeof LIVE_REFUSED_CODES)[number];
