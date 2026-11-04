/**
 * The custom name's states (hosted edition spec §23.2), as one pure function: where a claim goes after a check. The
 * check job holds and releases the name in `tenant_hosts` to match; nothing here touches the database.
 *
 * | State | Held in `tenant_hosts` | Served |
 * | --- | --- | --- |
 * | `pending` | no | no |
 * | `verified` | yes, not live | no |
 * | `active` | yes, live | yes, the primary |
 * | `failing` | yes | yes, while live |
 * | `lapsed`, `paused`, `expired` | no | no |
 *
 * A name that lapsed or paused released its hold, so it goes back through `verified` and has to be proved again, and
 * only the certificate probe (Part C) moves `verified` to `active`. A `failing` name kept its hold and its live row,
 * so a pass returns it to `active` as it was.
 */

export const DOMAIN_STATES = ['pending', 'verified', 'active', 'failing', 'lapsed', 'paused', 'expired'] as const;
export type DomainState = (typeof DOMAIN_STATES)[number];

/** The states whose name is held in `tenant_hosts`. */
export const HELD_STATES: readonly DomainState[] = ['verified', 'active', 'failing'];

/** A pending claim with no pass this long after it was made is `expired` (spec §23.2). */
export const PENDING_FOR_MS = 7 * 24 * 60 * 60_000;
/** A held name failing this long is `lapsed`, and released (spec §23.2). */
export const FAILING_FOR_MS = 72 * 60 * 60_000;

/** What one check saw. */
export interface Observation {
  /** The tenant's license grants `custom-domains`. */
  readonly featured: boolean;
  /** Both records passed and, for a name not yet held, the name was free to hold. Ignored without the feature. */
  readonly passed: boolean;
}

/** The claim's clocks that the timed moves read. */
export interface Since {
  readonly createdAt: Date;
  /** When the current run of failures began; null outside `failing`. */
  readonly failingSince: Date | null;
}

/**
 * Where a claim in `state` goes after `observation` at `now`.
 *
 * - Without the feature, every claim but an expired one is `paused`.
 * - A pass moves `pending`, `lapsed` and `paused` to `verified`, and keeps `verified` and `active`. It returns a
 *   `failing` name that is still `live` straight to `active`: it never released the name, so it needs no fresh proof
 *   and is never taken offline; a failing name that was never live goes to `verified`.
 * - A failure keeps `pending` for {@link PENDING_FOR_MS} after the claim, then `expired`; moves `verified` and
 *   `active` to `failing`; keeps `failing` for {@link FAILING_FOR_MS}, then `lapsed`; keeps the rest.
 * - `expired` stays until the claim is removed, pass or not.
 */
export function next(
  state: DomainState,
  observation: Observation,
  now: Date,
  since: Since,
  /** The claim's name is held and live in `tenant_hosts`: served, with its certificate. */
  live = false,
): DomainState {
  if (state === 'expired') return 'expired';
  if (!observation.featured) return 'paused';
  if (observation.passed) return state === 'active' || (state === 'failing' && live) ? 'active' : 'verified';
  switch (state) {
    case 'pending':
      return now.getTime() - since.createdAt.getTime() >= PENDING_FOR_MS ? 'expired' : 'pending';
    case 'verified':
    case 'active':
      return 'failing';
    case 'failing': {
      const from = since.failingSince ?? now;
      return now.getTime() - from.getTime() >= FAILING_FOR_MS ? 'lapsed' : 'failing';
    }
    case 'lapsed':
    case 'paused':
      return state;
  }
}

export const isHeld = (state: DomainState): boolean => HELD_STATES.includes(state);
